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

// p が既出 q の重複と確認できるか（§6.3）。3つの確認のいずれかが成立した
// ときだけ true。それ以外は両方残す。`budget` は候補グループ毎の
// サブシーケンス比較回数の上限。
//
// 安価な順に並べ替えてある: uuid（メモリ内比較）→ prefix（メモリ内比較）→
// 全ファイルハッシュ（遅延化されたため、初回はディスク読み＋ハッシュ計算が
// 走る）。ハッシュを最後にすることで、uuid か prefix で決着する大多数の
// ペアはディスクに触れない。
// 注意: どれかが成立すれば重複、という OR 判定なので並び順で真偽は変わらない
// が、prefix 確認が先に走ることで SUBSEQUENCE_LIMIT の予算消費パターンは
// 旧実装（uuid → ハッシュ → prefix）と異なり得る（旧実装ならハッシュで即決
// して予算を消費しなかったペアが、本実装では prefix 確認で予算を1つ消費する）。
//
// 差が出力に現れる条件（すべて同時に満たす必要がある）:
//   (1) 同一候補キー（source＋session＋質問時刻＋質問文が完全一致）のグループ
//       内で確認が SUBSEQUENCE_LIMIT（64）回を超えて行われ、かつ
//   (2) 予算切れ後のペアに「uuid では確認できないがファイル全体ハッシュ一致
//       では確認できた」ものが含まれる場合。
// このとき旧実装なら削除された重複が本実装では両方残る（出力が増える方向のみ。
// ペアが消える方向の差は起き得ない＝データを失わない側に倒れる）。実ログ・
// 全テストでは差は観測されていない。
//
// 旧順序（ハッシュを prefix より先）に戻せば予算消費まで完全一致するが、
// ハッシュは遅延化されたため、戻すと「prefix で決着するはずだった大多数の
// 古いスナップショット重複」で毎回2ファイルの全読み＋ハッシュ計算が強制発火
// し、遅延化の利得を打ち消す。安全性が keep-both 側に保たれていることを
// 優先し、現順序を維持する（R2 レポート改善要求への回答。SPEEDUP-NOTES 参照）。
async function confirmDuplicate(p: UnifiedPair, q: UnifiedPair, budget: { n: number }): Promise<boolean> {
  if (p.source !== q.source) return false;
  // 1. 同一セッション ＋ 質問イベント uuid の一致。
  if (p.sessionId && p.sessionId === q.sessionId && p.questionEventUuid && p.questionEventUuid === q.questionEventUuid) {
    return true;
  }
  // 2. 同一セッションで、片方のイベントID列がもう片方の厳密な前方 prefix
  //    （候補グループ毎に SUBSEQUENCE_LIMIT 回まで）。
  if (p.sessionId && p.sessionId === q.sessionId && budget.n < SUBSEQUENCE_LIMIT) {
    budget.n++;
    if (strictPrefix(p.eventIdStream, q.eventIdStream) || strictPrefix(q.eventIdStream, p.eventIdStream)) {
      return true;
    }
  }
  // 3. 全ファイル内容ハッシュの一致（完全コピー）— 遅延ディスク読み＋ハッシュ。
  //    '' は「確認できない」（読めない/解析後に変更された）を意味し、一致扱い
  //    にはしない。
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
  // observable (§6.3 診断要求 / r4 reports).
  possibleDuplicates: number;
}

// Conservative logical de-duplication (§6.3), applied AFTER the sort so
// "keep the first occurrence" is deterministic. When a confirmed duplicate is
// answered but the earlier kept copy is empty, the answered copy takes over the
// earlier copy's OUTPUT POSITION (so the reader gets the complete block without
// disturbing the deterministic order).
// confirmDuplicate が遅延ハッシュ（非同期ディスク読み）を含むため async。
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
