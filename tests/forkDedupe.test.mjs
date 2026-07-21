import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareUnifiedPairs, dedupeForkedSessions } from '../dist/lib/merge.js';

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
    forkKeys: o.forkKeys ?? [],
  };
}

test('fork dedupe: a forked copy in another session (shared question uuid) is removed once', () => {
  // Same turn, copied verbatim into a resumed session file: DIFFERENT sessionId,
  // SAME message uuid. dedupePairs can't see this; dedupeForkedSessions must.
  const orig = mkPair({ sessionId: 'a', forkKeys: ['q-1', 'a-1'] });
  const fork = mkPair({ sessionId: 'b', forkKeys: ['q-1', 'a-1'] });
  const { kept, removed } = dedupeForkedSessions([orig, fork].sort(compareUnifiedPairs));
  assert.equal(removed, 1);
  assert.equal(kept.length, 1);
});

test('fork dedupe: match on the ANSWER uuid alone (question side regrouped) still dedupes', () => {
  // A session-specific steering message shifts the question grouping, so the
  // question uuids differ, but the answer is the very same message.
  const orig = mkPair({ sessionId: 'a', forkKeys: ['q-1', 'ans-9'] });
  const fork = mkPair({ sessionId: 'b', forkKeys: ['q-2', 'ans-9'] });
  const { removed } = dedupeForkedSessions([orig, fork].sort(compareUnifiedPairs));
  assert.equal(removed, 1);
});

test('fork dedupe: distinct turns (no shared uuid) are both kept', () => {
  const p1 = mkPair({ sessionId: 'a', forkKeys: ['q-1', 'a-1'] });
  const p2 = mkPair({ sessionId: 'b', forkKeys: ['q-2', 'a-2'] });
  const { kept, removed } = dedupeForkedSessions([p1, p2].sort(compareUnifiedPairs));
  assert.equal(removed, 0);
  assert.equal(kept.length, 2);
});

test('fork dedupe: Codex pairs (empty forkKeys) are NEVER deduped even if their positional uuids collide', () => {
  // Codex synthesizes uuids per file (u-0, a-1, …), so two distinct Codex
  // sessions share questionEventUuid 'u-0'. toUnifiedPair leaves forkKeys empty
  // for Codex precisely so these are not merged. Simulate that here.
  const cx1 = mkPair({ source: 'codex', sessionId: 'x', questionEventUuid: 'u-0', forkKeys: [] });
  const cx2 = mkPair({ source: 'codex', sessionId: 'y', questionEventUuid: 'u-0', forkKeys: [] });
  const { kept, removed } = dedupeForkedSessions([cx1, cx2].sort(compareUnifiedPairs));
  assert.equal(removed, 0);
  assert.equal(kept.length, 2);
});

test('fork dedupe: a pair with no forkKeys is always kept (never a duplicate)', () => {
  const p1 = mkPair({ sessionId: 'a', forkKeys: [] });
  const p2 = mkPair({ sessionId: 'b', forkKeys: ['q-1'] });
  const p3 = mkPair({ sessionId: 'c', forkKeys: [] });
  const { kept, removed } = dedupeForkedSessions([p1, p2, p3].sort(compareUnifiedPairs));
  assert.equal(removed, 0);
  assert.equal(kept.length, 3);
});

test('fork dedupe: keeps the FIRST occurrence, removes the later copy', () => {
  const early = mkPair({ sessionId: 'a', questionTimestampRaw: '2026-05-27T10:00:00.000Z', answer: 'FIRST', forkKeys: ['q-7'] });
  const late = mkPair({ sessionId: 'b', questionTimestampRaw: '2026-05-27T12:00:00.000Z', answer: 'COPY', forkKeys: ['q-7'] });
  const { kept, removed } = dedupeForkedSessions([late, early].sort(compareUnifiedPairs));
  assert.equal(removed, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].answer, 'FIRST');
});
