import { sha256Hex } from '../../lib/pathUtils.js';
import type { TokenTotals, UnifiedPair } from '../../lib/types.js';
import type { SessionData } from '../adapter.js';

// Removal of the parent conversation that a Codex subagent rollout re-records
// into its own file.
//
// Every time Codex CLI starts a subagent it writes a new rollout and copies the
// parent session's ENTIRE conversation into it, rewriting each copied line's
// outer timestamp to the child's start time. ccxlog trusts the timestamps in
// the log, so months-old questions reappeared as brand-new ones — 814 of the
// 1,183 rendered Codex questions in the measured project — and because they are
// inserted into the MIDDLE of the timeline the output could no longer be
// appended to (1,522 rewrites against 46 appends over 26.75 hours).
//
// The rule is deliberately one-directional: a child pair is dropped ONLY when
// the very same pair can be found in an older ancestor of its own lineage AND
// everything the child's copy holds either already exists there or can be moved
// there. Anything else stays — a pair whose key material is missing, a pair the
// ancestor never had, and in particular everything a compacted child no longer
// shares with its parent.
//
// Three things this must NOT do, each of which loses data:
//  - remove "everything that came from the parent" wholesale. After compaction
//    the child holds history the parent no longer has.
//  - replace the ancestor pair with the child's copy. The child's copy carries
//    the REWRITTEN timestamp, which is the whole problem, and swapping it in
//    would also move the surviving pair's ccxlogid. Fields are merged INTO the
//    ancestor, so what survives is always the older copy.
//  - drop a child pair holding an answer the ancestor never gave. There is no
//    safe way to show two different answers in one block, so the child pair is
//    kept instead and counted, rather than silently disappearing.

export interface ReplaySession {
  session: SessionData;
  pairs: UnifiedPair[];
}

export interface InheritedHistoryResult {
  /** Child pairs recognised as a replay of an ancestor pair and dropped. */
  removed: number;
  /** Removed copies that contributed answer, progress or token data to a surviving pair. */
  merged: number;
  /**
   * Recognised replays that were KEPT because the child's copy carried an
   * answer, or progress records, the ancestor could not absorb. Reported so
   * that "a block vanished and nothing gained its content" is impossible to
   * reach unnoticed.
   */
  conflicts: number;
  /**
   * One line per kept conflict, for --verbose: which of the two reasons it
   * was, the session, and the start of the question. Enough to find the block.
   */
  conflictNotes: string[];
}

// A one-line, single-line-safe excerpt of a question, for diagnostics.
function excerpt(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

// A cyclic parent_thread_id chain would be a corrupt log, but it must not hang
// the run, so the walk is bounded.
const MAX_ANCESTRY_DEPTH = 64;

const TOKEN_FIELDS: Array<keyof TokenTotals> = [
  'input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'reasoning',
];

function mergeTokenTotals(target: UnifiedPair, source: UnifiedPair): boolean {
  let enriched = false;
  for (const field of TOKEN_FIELDS) {
    const a = target.tokens[field];
    const b = source.tokens[field];
    if (b === undefined) continue;
    if (a === undefined || b > a) {
      target.tokens[field] = b;
      enriched = true;
    }
  }
  return enriched;
}

function threadOf(s: ReplaySession) {
  return s.session.source === 'codex' ? s.session.thread : undefined;
}

// The ancestors of a subagent session, nearest first.
//
// Ancestry is read from the log's own parent_thread_id chain plus the lineage
// root (`session_id`), never from the order the files happened to be discovered
// in. That is what makes the outcome independent of extraLogDirs ordering:
// whichever file is read first, the parent is still the parent.
function ancestorsOf(s: ReplaySession, byThread: Map<string, ReplaySession>): ReplaySession[] {
  const out: ReplaySession[] = [];
  const seen = new Set<string>();
  const selfId = threadOf(s)?.threadId ?? '';
  if (selfId) seen.add(selfId);

  let cur: ReplaySession | undefined = s;
  for (let depth = 0; cur && depth < MAX_ANCESTRY_DEPTH; depth++) {
    const parentId = threadOf(cur)?.parentThreadId ?? '';
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byThread.get(parentId);
    if (!parent) break;              // the parent log is not part of this project
    out.push(parent);
    cur = parent;
  }

  // The lineage root stays reachable when the chain is broken — the direct
  // parent's rollout was filtered out by cwd, or was never discovered — so it
  // is added separately rather than only through the walk.
  const rootId = threadOf(s)?.lineageSessionId ?? '';
  if (rootId && !seen.has(rootId)) {
    const root = byThread.get(rootId);
    if (root) out.push(root);
  }
  return out;
}

// Can this child pair be folded into the ancestor's without losing anything?
//
// Two things can block it: an answer the ancestor does not have, and progress
// records the ancestor does not have. Everything else the child may hold more
// of is moved over, and everything that decides where and when the block
// appears (question text, timestamp, session, cwd, branch, model) stays with
// the ancestor, so its position and its ccxlogid never move.
//
// "Does not have" is checked against every text the ancestor's copy of the turn
// could show as its answer, not just the one it renders. A turn produces
// several assistant messages and only the last is the answer; a subagent
// spawned mid-turn copied the turn as far as it had got, so its copy ends on an
// EARLIER message of the same turn. Comparing the rendered answers alone calls
// that a disagreement — of the 21 apparent disagreements on real logs, 4 were
// exactly this and the ancestor held those texts already, while the remaining
// 17 were answers the ancestor genuinely never gave and are kept.
function answerAbsorbable(target: UnifiedPair, source: UnifiedPair): boolean {
  if (!source.answer || target.answer === source.answer) return true;
  if (!target.answer) return true;
  return target.answerTextHashes.includes(sha256Hex(source.answer));
}

type ProgressVerdict = 'target-richer' | 'source-richer' | 'divergent';

/**
 * Is `a` an ordered subsequence of `b`? Greedy is exact here because the check
 * is one-directional and the elements are compared for equality: if a greedy
 * scan cannot place every element of `a` in order, no assignment can.
 */
function isOrderedSubsequence(a: string[], b: string[]): boolean {
  if (a.length > b.length) return false;
  let i = 0;
  for (const item of b) {
    if (i < a.length && a[i] === item) i++;
  }
  return i === a.length;
}

/**
 * Which copy's progress covers the other's (§ requirement 5, "complete from the
 * richer copy").
 *
 * The previous rule was "whichever copy has MORE records wins, wholesale". That
 * is an approximation with a real failure mode: a child holding more records
 * whose content has diverged — a compacted re-recording, say — would replace
 * the ancestor's list outright and take everything only the ancestor had with
 * it. Answers were already guarded this way; progress was not.
 *
 * Containment is decided on the signature (lib/replayKey.progressSignatureOf),
 * never on rendered Progress text. Rendering would build both sides — the work
 * v1.6.0 made lazy — and, because the retention pass empties Progress whenever
 * the template does not reference it, comparing rendered text would make the
 * TEMPLATE decide which blocks survive. That is the defect this generation is
 * required not to inherit.
 */
function compareProgress(target: UnifiedPair, source: UnifiedPair): ProgressVerdict {
  // The cheap counts settle the two common cases without materialising either
  // signature: nothing to gain, or nothing to lose.
  if (source.progressEntryCount === 0) return 'target-richer';
  if (target.progressEntryCount === 0) return 'source-richer';
  const t = target.progressSignature();
  const s = source.progressSignature();
  if (isOrderedSubsequence(s, t)) return 'target-richer';   // covers the equal case
  if (isOrderedSubsequence(t, s)) return 'source-richer';
  return 'divergent';
}

// § requirement 5, field by field. Returns true when the ancestor actually
// gained something. Only ever called once the pair has been found absorbable.
function mergeInto(target: UnifiedPair, source: UnifiedPair, progress: ProgressVerdict): boolean {
  let enriched = false;
  if (!target.answer && source.answer) {
    target.answer = source.answer;
    enriched = true;
  }
  // Tokens field by field, taking the LARGER value rather than only filling
  // gaps. A turn the ancestor recorded while it was still running carries a
  // partial count for a field the finished child copy has in full, and "fill
  // only what is undefined" keeps the partial one. `undefined` stays
  // meaningful: a field neither copy reported is never invented, so a known 0
  // is still distinguishable from "not reported" (§6.1).
  if (mergeTokenTotals(target, source)) enriched = true;
  // Progress moves over only when the child's list is confirmed to CONTAIN the
  // ancestor's; a divergent pair never gets here (it is kept instead), and a
  // child covered by the ancestor leaves the ancestor's own accessors untouched
  // — so the usual case costs nothing and stays lazy.
  if (progress === 'source-richer') {
    target.progressSummary = source.progressSummary;
    target.progressFull = source.progressFull;
    target.progressEntryCount = source.progressEntryCount;
    target.progressSignature = source.progressSignature;
    enriched = true;
  }
  return enriched;
}

// The ancestor pair this pair is a replay of, or undefined. The key proves
// identity; the ordered text of every user message is compared as the final
// confirmation, so a key collision — a turn ordinal shifted by compaction, say
// — can never delete a differently-worded question.
function findAncestorCopy(p: UnifiedPair, index: Map<string, UnifiedPair[]>): UnifiedPair | undefined {
  if (!p.replayKey) return undefined;
  for (const candidate of index.get(p.replayKey) ?? []) {
    if (candidate.replayTextHash === p.replayTextHash) return candidate;
  }
  return undefined;
}

/**
 * Drop the inherited conversation from every Codex subagent session in
 * `sessions`, merging what only the child's copy had into the ancestor pair
 * that survives. `sessions[i].pairs` is replaced with the kept pairs; ancestor
 * pairs are enriched in place, so aggregate and per-session output — which
 * share these very objects — necessarily agree.
 *
 * Call this BEFORE the output mode is chosen and before ccxlogids are assigned:
 * per-session output has no cross-session dedupe of its own, so a removal
 * decided later would apply to only one of the two modes.
 */
export function removeInheritedHistory(sessions: ReplaySession[]): InheritedHistoryResult {
  const byThread = new Map<string, ReplaySession>();
  for (const s of sessions) {
    const t = threadOf(s);
    if (!t?.threadId) continue;
    if (!byThread.has(t.threadId)) byThread.set(t.threadId, s);
  }

  const subagents = sessions.filter(s => threadOf(s)?.isSubagent);
  if (subagents.length === 0) return { removed: 0, merged: 0, conflicts: 0, conflictNotes: [] };

  // Shallow threads first, so a grandchild is matched against a parent whose
  // own inherited pairs have already been folded into the lineage root. Depth
  // ties are broken on the thread id — never on the discovery order — which is
  // what keeps two siblings from deciding differently depending on which file
  // was read first.
  const depth = new Map<ReplaySession, number>();
  for (const s of subagents) depth.set(s, ancestorsOf(s, byThread).length);
  subagents.sort((a, b) => {
    const d = (depth.get(a) ?? 0) - (depth.get(b) ?? 0);
    if (d !== 0) return d;
    const ai = threadOf(a)?.threadId ?? '';
    const bi = threadOf(b)?.threadId ?? '';
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });

  let removed = 0;
  let merged = 0;
  const conflictNotesByPair = new Map<UnifiedPair, string>();
  // Pairs an ancestor confirmed as its own record but which were kept anyway,
  // because the child's copy carried something the ancestor could not absorb.
  // ONLY these take part in the sibling pass below — a subagent's own work was
  // never inherited from anywhere and must never be dropped against a sibling.
  const inherited = new Set<UnifiedPair>();
  for (const child of subagents) {
    const ancestors = ancestorsOf(child, byThread);
    if (ancestors.length === 0) continue;   // no older copy to confirm against — keep everything

    const index = new Map<string, UnifiedPair[]>();
    for (const ancestor of ancestors) {
      for (const p of ancestor.pairs) {
        if (!p.replayKey) continue;
        const bucket = index.get(p.replayKey);
        if (bucket) bucket.push(p); else index.set(p.replayKey, [p]);
      }
    }
    if (index.size === 0) continue;

    const kept: UnifiedPair[] = [];
    for (const p of child.pairs) {
      const older = findAncestorCopy(p, index);
      if (!older) { kept.push(p); continue; }
      // Confirmed the same question. It may still carry something the ancestor
      // does not have, in which case keeping the child's block is the only
      // option that loses nothing — the count says how often it happened and
      // the note says where to look, and which of the two reasons it was.
      if (!answerAbsorbable(older, p)) {
        conflictNotesByPair.set(p, `answer  ${p.sessionId}: ${excerpt(p.question)}`);
        kept.push(p);
        inherited.add(p);
        continue;
      }
      const progress = compareProgress(older, p);
      if (progress === 'divergent') {
        conflictNotesByPair.set(p, `progress ${p.sessionId}: ${excerpt(p.question)}`);
        kept.push(p);
        inherited.add(p);
        continue;
      }
      removed++;
      if (mergeInto(older, p, progress)) merged++;
    }
    child.pairs = kept;
  }

  // Sibling pass. Everything above compares a child against its ANCESTORS, so
  // when several children of one parent each re-record the same turn, each one
  // differs from the ancestor in the same way and all of them are kept — the
  // user sees the identical question and the identical answer four times over.
  // In the measured case, one question was re-recorded by four subagents and
  // all four copies ended with the same answer.
  //
  // Two children hold the same record when their replay key, question-text
  // hash, answer and progress signature all match. Token fields from the later
  // copy are merged into the survivor before it is dropped. This stays inside
  // the "never delete unconfirmed" rule: the surviving copy IS the
  // confirmation, and no rendered information is discarded.
  const seen = new Map<string, UnifiedPair>();
  for (const child of subagents) {
    const t = threadOf(child);
    if (!t?.isSubagent) continue;
    const kept: UnifiedPair[] = [];
    for (const p of child.pairs) {
      // Only copies an ancestor already confirmed. The child's own work is not
      // a copy of anything and stays untouched, even when two subagents happen
      // to produce the same text.
      if (!inherited.has(p) || !p.replayKey) { kept.push(p); continue; }
      // Lineage is part of the key: two unrelated threads that happen to share
      // a question are not copies of one another.
      const lineage = t.lineageSessionId || t.parentThreadId;
      if (!lineage) { kept.push(p); continue; }
      const key = JSON.stringify([
        lineage,
        p.replayKey,
        p.replayTextHash,
        p.answer,
        p.progressSignature(),
      ]);
      const first = seen.get(key);
      if (!first) { seen.set(key, p); kept.push(p); continue; }
      if (mergeTokenTotals(first, p)) merged++;
      conflictNotesByPair.delete(p);
      inherited.delete(p);
      removed++;
    }
    child.pairs = kept;
  }

  return {
    removed,
    merged,
    conflicts: conflictNotesByPair.size,
    conflictNotes: [...conflictNotesByPair.values()],
  };
}

/**
 * The per-session file name a subagent used BEFORE its id was separated from
 * its parent's — i.e. the lineage id — for every subagent that now writes under
 * its own thread id. Used to clean up the leftovers of the old naming
 * (§ requirement 8); the caller still checks the file's owner marker before
 * touching it.
 */
export function legacySessionIds<T extends ReplaySession>(sessions: T[]): Map<T, string> {
  const out = new Map<T, string>();
  for (const s of sessions) {
    const t = threadOf(s);
    if (!t?.isSubagent) continue;
    if (!t.lineageSessionId || t.lineageSessionId === s.session.sessionId) continue;
    out.set(s, t.lineageSessionId);
  }
  return out;
}
