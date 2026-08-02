import { sha256Hex } from './pathUtils.js';
import type { UnifiedPair } from './types.js';

// 8-key deterministic comparator (§7.1). Absolute paths are never used.
export function compareUnifiedPairs(a: UnifiedPair, b: UnifiedPair): number {
  // 1. valid-time flag: valid timestamps first, unparseable last.
  const aValid = a.questionTimestampMs !== null;
  const bValid = b.questionTimestampMs !== null;
  if (aValid !== bValid) return aValid ? -1 : 1;
  // 2. questionTimestampMs ascending (both valid).
  if (aValid && bValid && a.questionTimestampMs !== b.questionTimestampMs) {
    return (a.questionTimestampMs as number) - (b.questionTimestampMs as number);
  }
  // 3. questionTimestampRaw codepoint order.
  if (a.questionTimestampRaw !== b.questionTimestampRaw) {
    return a.questionTimestampRaw < b.questionTimestampRaw ? -1 : 1;
  }
  // 4. source: claude < codex.
  if (a.source !== b.source) return a.source === 'claude' ? -1 : 1;
  // 5. sessionId codepoint order.
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
  // 6. questionEventUuid codepoint order (absent side first).
  const au = a.questionEventUuid ?? '';
  const bu = b.questionEventUuid ?? '';
  if (au !== bu) return au < bu ? -1 : 1;
  // 7. sourceFileRelativeId codepoint order.
  if (a.sourceFileRelativeId !== b.sourceFileRelativeId) {
    return a.sourceFileRelativeId < b.sourceFileRelativeId ? -1 : 1;
  }
  // 8. questionOrdinal numeric ascending.
  return a.questionOrdinal - b.questionOrdinal;
}

const SUBSEQUENCE_LIMIT = 64;

// Candidate key (§6.3). The answer is deliberately EXCLUDED so an unanswered
// old snapshot and a later answered copy of the same question land in the same
// candidate group and reach confirmDuplicate() (which is what lets the answered
// copy supersede the empty one below). This is the answer-independent dedupe
// key; it is unrelated to the answer-independent ccxlogId material (§9.2), which
// serves a different purpose. NUL (\0) joins the fields so a boundary can't be
// injected by content that itself contains spaces.
function dupKey(p: UnifiedPair): string {
  const session = p.sessionId || p.sourceFileRelativeId;
  return sha256Hex(`${p.source}\0${session}\0${p.questionTimestampRaw}\0${p.question}`);
}

function strictPrefix(a: string[], b: string[]): boolean {
  // True when `a` is a strict forward prefix of `b` (older snapshot).
  if (a.length >= b.length || a.length === 0) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Can p be confirmed as a duplicate of the already-seen q (§6.3)? True only when
// one of the three confirmations holds; otherwise BOTH copies are kept. `budget`
// caps the number of subsequence comparisons per candidate group.
//
// The checks are ordered cheapest first: uuid (in memory) -> prefix (in memory)
// -> whole-file hash (now lazy, so the first call costs a disk read plus the
// hash). Putting the hash last keeps the vast majority of pairs — settled by
// uuid or prefix — off the disk entirely.
// Note: this is an OR, so the order cannot change the verdict; but running the
// prefix check first does change how the SUBSEQUENCE_LIMIT budget is spent
// compared with the old order (uuid -> hash -> prefix). A pair the old order
// would have settled by hash without spending budget now spends one unit on the
// prefix check.
//
// For that difference to reach the output, all of the following must hold at
// once:
//   (1) within one candidate-key group (identical source + session + question
//       timestamp + question text) more than SUBSEQUENCE_LIMIT (64)
//       confirmations are performed, AND
//   (2) among the pairs past the exhausted budget there is one that uuid cannot
//       confirm but a whole-file hash match would have.
// In that case a duplicate the old order deleted is kept twice here. The
// difference can only ADD output; a pair can never disappear, so it fails toward
// not losing data. No difference has been observed on real logs or in any test.
//
// Restoring the old order (hash before prefix) would match the old budget
// spending exactly, but since the hash became lazy that would force a full read
// of two files plus a hash for the vast majority of old-snapshot duplicates that
// the prefix check settles on its own, cancelling out the benefit of making it
// lazy. Since the safety stays on the keep-both side, the current order stands
// (see SPEEDUP-NOTES).
async function confirmDuplicate(p: UnifiedPair, q: UnifiedPair, budget: { n: number }): Promise<boolean> {
  if (p.source !== q.source) return false;
  // 1. Same session + matching question-event uuid.
  if (p.sessionId && p.sessionId === q.sessionId && p.questionEventUuid && p.questionEventUuid === q.questionEventUuid) {
    return true;
  }
  // 2. Same session, and one event-id stream is a strict leading prefix of the
  //    other (up to SUBSEQUENCE_LIMIT times per candidate group).
  if (p.sessionId && p.sessionId === q.sessionId && budget.n < SUBSEQUENCE_LIMIT) {
    budget.n++;
    if (strictPrefix(p.eventIdStream, q.eventIdStream) || strictPrefix(q.eventIdStream, p.eventIdStream)) {
      return true;
    }
  }
  // 3. Matching whole-file content hash (a complete copy) — a lazy disk read
  //    plus hash. '' means "cannot confirm" (unreadable, or modified after
  //    analysis) and is never treated as a match.
  const ph = await p.fileContentHash();
  if (ph) {
    const qh = await q.fileContentHash();
    if (qh && ph === qh) return true;
  }
  return false;
}

export interface ForkDedupeResult {
  kept: UnifiedPair[];
  removed: number;
}

// Cross-session de-duplication of resumed/forked copies (aggregate output only),
// applied AFTER dedupePairs and AFTER the sort so "keep the first occurrence" is
// deterministic. When a Claude session is resumed or forked, Claude Code copies
// the earlier conversation verbatim into the NEW session file, so the same
// message — identical uuid — appears under a DIFFERENT sessionId. dedupePairs
// cannot catch these: its candidate key (dupKey) is per-session, and every
// confirmation but the whole-file-hash one requires the same sessionId, so two
// forked copies never even land in the same group. We remove them here by uuid.
//
// A pair is a fork duplicate if ANY of its forkKeys (question uuid, steering
// follow-up uuids, or the answer uuid) was already emitted by an earlier pair.
// Keeping the first (earliest, since already sorted) occurrence is lossless: a
// uuid is unique per message, so a hit is always the same message copied by a
// fork, never two distinct turns. Pairs with no forkKeys (every Codex pair —
// whose uuids are per-file positional and would collide across sessions — and
// any Claude pair whose messages all lack a uuid) are never treated as
// duplicates.
export function dedupeForkedSessions(sorted: UnifiedPair[]): ForkDedupeResult {
  const seen = new Set<string>();
  const kept: UnifiedPair[] = [];
  let removed = 0;
  for (const p of sorted) {
    const keys = p.forkKeys ?? [];
    if (keys.length === 0) { kept.push(p); continue; }
    if (keys.some(k => seen.has(k))) { removed++; continue; }
    for (const k of keys) seen.add(k);
    kept.push(p);
  }
  return { kept, removed };
}

export interface DedupeResult {
  kept: UnifiedPair[];
  removed: number;
  // Pairs that matched a candidate key group (§6.3 dupKey) but could NOT be
  // confirmed as duplicates, so BOTH copies were kept. Surfaced via --verbose
  // as "possible duplicate" so the conservative keep-both decisions are
  // observable (§6.3 diagnostics requirement / r4 reports).
  possibleDuplicates: number;
}

// Conservative logical de-duplication (§6.3), applied AFTER the sort so
// "keep the first occurrence" is deterministic. When a confirmed duplicate is
// answered but the earlier kept copy is empty, the answered copy takes over the
// earlier copy's OUTPUT POSITION (so the reader gets the complete block without
// disturbing the deterministic order).
// It is async because confirmDuplicate involves the lazy hash (an async disk read).
export async function dedupePairs(sorted: UnifiedPair[]): Promise<DedupeResult> {
  const groups = new Map<string, { members: UnifiedPair[]; budget: { n: number } }>();
  const kept: UnifiedPair[] = [];
  let removed = 0;
  let possibleDuplicates = 0;
  for (const p of sorted) {
    const key = dupKey(p);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { members: [p], budget: { n: 0 } });
      kept.push(p);
      continue;
    }
    let dupOf = -1;
    for (let i = 0; i < group.members.length; i++) {
      if (await confirmDuplicate(p, group.members[i], group.budget)) { dupOf = i; break; }
    }
    if (dupOf >= 0) {
      removed++;
      // Answered-copy-wins: if the earlier kept member has no answer but p does,
      // swap p into its position (same order, richer content).
      const old = group.members[dupOf];
      if (!old.answer && p.answer) {
        group.members[dupOf] = p;
        const keptIndex = kept.indexOf(old);
        if (keptIndex >= 0) kept[keptIndex] = p;
      }
    } else {
      // Shares a candidate key with the group but no confirmation held — keep
      // both (conservative) and record it as a possible duplicate.
      group.members.push(p);
      kept.push(p);
      possibleDuplicates++;
    }
  }
  return { kept, removed, possibleDuplicates };
}
