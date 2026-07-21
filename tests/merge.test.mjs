import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareUnifiedPairs, dedupePairs } from '../dist/lib/merge.js';

let seq = 0;
function mkPair(o = {}) {
  const raw = o.questionTimestampRaw ?? '2026-05-27T11:03:49.000Z';
  const ms = raw ? Date.parse(raw) : NaN;
  return {
    source: o.source ?? 'claude',
    sourceLabel: (o.source ?? 'claude') === 'claude' ? 'ClaudeCode' : 'Codex',
    sessionId: o.sessionId ?? 's1',
    sessionName: '',
    sourceFile: o.sourceFile ?? `/abs/${seq}.jsonl`,
    sourceFileRelativeId: o.sourceFileRelativeId ?? `claude/standard/std/${seq++}.jsonl`,
    questionEventUuid: o.questionEventUuid,
    questionOrdinal: o.questionOrdinal ?? 0,
    questionTimestampRaw: raw,
    questionTimestampMs: Number.isNaN(ms) ? null : ms,
    question: o.question ?? 'Q',
    progressSummary: '', progressFull: '',
    answer: o.answer ?? '',
    model: '', version: '', gitBranch: '', cwd: '',
    tokens: {},
    ccxid: '',
    fileContentHash: o.fileContentHash ?? '',
    eventIdStreamHash: o.eventIdStreamHash ?? [],
  };
}

test('comparator: valid timestamps sort before unparseable', () => {
  const valid = mkPair({ questionTimestampRaw: '2026-05-27T10:00:00.000Z' });
  const bad = mkPair({ questionTimestampRaw: 'not-a-date' });
  assert.ok(compareUnifiedPairs(valid, bad) < 0);
  assert.ok(compareUnifiedPairs(bad, valid) > 0);
});

test('comparator: ascending time, then claude before codex on a tie', () => {
  const early = mkPair({ questionTimestampRaw: '2026-05-27T10:00:00.000Z' });
  const late = mkPair({ questionTimestampRaw: '2026-05-27T12:00:00.000Z' });
  assert.ok(compareUnifiedPairs(early, late) < 0);
  const cc = mkPair({ source: 'claude', questionTimestampRaw: '2026-05-27T10:00:00.000Z' });
  const cx = mkPair({ source: 'codex', questionTimestampRaw: '2026-05-27T10:00:00.000Z' });
  assert.ok(compareUnifiedPairs(cc, cx) < 0);
});

test('comparator: total order is deterministic and reproducible', () => {
  const pairs = [
    mkPair({ source: 'codex', sessionId: 'b', questionTimestampRaw: '2026-05-27T10:00:00.000Z' }),
    mkPair({ source: 'claude', sessionId: 'a', questionTimestampRaw: '2026-05-27T10:00:00.000Z' }),
    mkPair({ source: 'claude', sessionId: 'a', questionTimestampRaw: '2026-05-27T09:00:00.000Z' }),
  ];
  const a = [...pairs].sort(compareUnifiedPairs).map(p => p.sourceFileRelativeId);
  const b = [...pairs].reverse().sort(compareUnifiedPairs).map(p => p.sourceFileRelativeId);
  assert.deepEqual(a, b);
});

test('dedupe: identical full-file copy is removed once', () => {
  const p1 = mkPair({ sessionId: 's', question: 'Same', fileContentHash: 'HASH' });
  const p2 = mkPair({ sessionId: 's', question: 'Same', fileContentHash: 'HASH' });
  const { kept, removed } = dedupePairs([p1, p2].sort(compareUnifiedPairs));
  assert.equal(removed, 1);
  assert.equal(kept.length, 1);
});

test('dedupe: cross-source same text is always kept (both)', () => {
  const cc = mkPair({ source: 'claude', sessionId: 's', question: 'Same', fileContentHash: 'H' });
  const cx = mkPair({ source: 'codex', sessionId: 's', question: 'Same', fileContentHash: 'H' });
  const { kept, removed } = dedupePairs([cc, cx].sort(compareUnifiedPairs));
  assert.equal(removed, 0);
  assert.equal(kept.length, 2);
});

test('dedupe: unconfirmed same text is kept (conservative)', () => {
  // Same question text but different session and no confirming evidence.
  const p1 = mkPair({ sessionId: 's1', question: 'Same' });
  const p2 = mkPair({ sessionId: 's2', question: 'Same' });
  const { removed } = dedupePairs([p1, p2].sort(compareUnifiedPairs));
  assert.equal(removed, 0);
});

test('dedupe: a same-key but unconfirmed pair is counted as a possible duplicate', () => {
  // Same source+session+timestamp+question (same candidate key) but no
  // confirmation (no uuid, no file hash, event streams are not prefixes) ->
  // both kept AND surfaced as a possible duplicate for --verbose (§6.3).
  const p1 = mkPair({ sessionId: 's', question: 'Same', eventIdStreamHash: ['a'] });
  const p2 = mkPair({ sessionId: 's', question: 'Same', eventIdStreamHash: ['b'] });
  const { kept, removed, possibleDuplicates } = dedupePairs([p1, p2].sort(compareUnifiedPairs));
  assert.equal(removed, 0);
  assert.equal(kept.length, 2);
  assert.equal(possibleDuplicates, 1);
});

test('dedupe: different-session same text is NOT a possible duplicate (different key)', () => {
  const p1 = mkPair({ sessionId: 's1', question: 'Same' });
  const p2 = mkPair({ sessionId: 's2', question: 'Same' });
  const { possibleDuplicates } = dedupePairs([p1, p2].sort(compareUnifiedPairs));
  assert.equal(possibleDuplicates, 0);
});

test('comparator: a missing questionEventUuid sorts before a present one (key 6)', () => {
  const ts = '2026-05-27T10:00:00.000Z';
  // Equal on keys 1-5 (time / source / session); differ only on key 6.
  const noUuid = mkPair({ sessionId: 's', questionTimestampRaw: ts, questionEventUuid: '' });
  const withUuid = mkPair({ sessionId: 's', questionTimestampRaw: ts, questionEventUuid: 'aaa' });
  assert.ok(compareUnifiedPairs(noUuid, withUuid) < 0);
  assert.ok(compareUnifiedPairs(withUuid, noUuid) > 0);
});

test('CC#3: the NUL candidate-key boundary keeps two distinct same-file pairs from merging', () => {
  // Two DIFFERENT logical pairs whose candidate-key material would be byte-
  // identical if the fields were joined with a SPACE:
  //   p1: session="s x", timestampRaw="2026"    -> "claude s x 2026 q"
  //   p2: session="s",   timestampRaw="x 2026"   -> "claude s x 2026 q"
  // They also share a fileContentHash, so IF their keys collided, confirmation
  // #2 (identical whole-file hash) would DELETE one distinct pair. A real NUL
  // (\0) separator can never be forged by the embedded space, so both survive.
  const p1 = mkPair({ sessionId: 's x', questionTimestampRaw: '2026', question: 'q', fileContentHash: 'SAME' });
  const p2 = mkPair({ sessionId: 's', questionTimestampRaw: 'x 2026', question: 'q', fileContentHash: 'SAME' });
  const { kept, removed } = dedupePairs([p1, p2].sort(compareUnifiedPairs));
  assert.equal(removed, 0, 'distinct pairs must not be merged by a forged boundary');
  assert.equal(kept.length, 2);
});

test('dedupe: answered copy supersedes the empty snapshot in place', () => {
  // Older unanswered snapshot (strict-prefix event stream), then answered copy.
  const older = mkPair({ sessionId: 's', question: 'Q', answer: '', eventIdStreamHash: ['a', 'b'] });
  const newer = mkPair({ sessionId: 's', question: 'Q', answer: 'DONE', eventIdStreamHash: ['a', 'b', 'c'] });
  const { kept, removed } = dedupePairs([older, newer].sort(compareUnifiedPairs));
  assert.equal(removed, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].answer, 'DONE'); // richer answered copy won the slot
});
