import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTokens, extractTokenTotals } from '../dist/lib/metaExtractor.js';

// Build a minimal Pair around the given assistant entries.
function pairWith(assistants) {
  return {
    questionEntry: { type: 'user', uuid: 'q', timestamp: '', message: { role: 'user', content: 'q' } },
    additionalQuestionEntries: [],
    progressEntries: [],
    finalAssistantEntry: assistants.length
      ? { type: 'assistant', uuid: 'a', timestamp: '', message: { role: 'assistant', content: [], ...assistants[assistants.length - 1] } }
      : null,
  };
}

test('formatTokens: all-undefined renders empty', () => {
  assert.equal(formatTokens({}), '');
});

test('formatTokens: a defined ZERO renders "0", it is not blanked (§7.2 undefined-vs-0)', () => {
  // Codex always defines input/output/cacheRead/reasoning, so a genuinely
  // zero-usage pair must show "in 0, out 0, …" — not an empty string. The old
  // sum===0 shortcut wrongly blanked these.
  const out = formatTokens({ input: 0, output: 0, cacheRead: 0, reasoning: 0 });
  assert.equal(out, 'in 0, out 0, cache read 0, reasoning 0');
});

test('formatTokens: reasoning 0 is shown (defined), undefined reasoning is omitted', () => {
  assert.equal(formatTokens({ input: 5, output: 3, reasoning: 0 }), 'in 5, out 3, reasoning 0');
  // Claude-style: reasoning undefined -> omitted, cache write shown.
  assert.equal(
    formatTokens({ input: 6, output: 33, cacheRead: 21758, cacheWrite5m: 8730 }),
    'in 6, out 33, cache read 21,758, cache write 8,730',
  );
});

test('extractTokenTotals: pair with NO usage entry -> all undefined -> Tokens= (empty)', () => {
  // Parity with cclog: a token-less pair (assistant turns carry no `usage`)
  // must render an empty Tokens field, not "in 0, out 0, …" (§7.2).
  const claude = extractTokenTotals(pairWith([{ model: 'claude-opus-4-8' }]), 'claude');
  assert.deepEqual(claude, {});
  assert.equal(formatTokens(claude), '');

  const codex = extractTokenTotals(pairWith([{}]), 'codex');
  assert.deepEqual(codex, {});
  assert.equal(formatTokens(codex), '');

  // A pair with no assistant entries at all is likewise empty.
  assert.deepEqual(extractTokenTotals(pairWith([]), 'claude'), {});
});

test('extractTokenTotals: a present-but-zero usage entry keeps defined zeros (known-0 vs absent)', () => {
  // usage object exists (all zero) -> defined zeros, so the distinction between
  // a genuine 0 and "no usage reported" is preserved (§6.1).
  const codex = extractTokenTotals(pairWith([{ usage: {} }]), 'codex');
  assert.deepEqual(codex, { input: 0, output: 0, cacheRead: 0, reasoning: 0 });
  assert.equal(formatTokens(codex), 'in 0, out 0, cache read 0, reasoning 0');

  const claude = extractTokenTotals(pairWith([{ usage: { input_tokens: 6, output_tokens: 33 } }]), 'claude');
  assert.deepEqual(claude, { input: 6, output: 33, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.equal(formatTokens(claude), 'in 6, out 33, cache read 0, cache write 0');
});
