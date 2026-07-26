// Safe-amendment detection (§backup-free rewrite): when the only difference
// is "an unfinished pair got filled in + new pairs appended", the write is an
// 'amend' (rewrite WITHOUT a pre-overwrite backup). Anything that could lose
// old content must stay a backed-up 'rewrite'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planWrite, commitPlan } from '../dist/lib/markdownWriter.js';
import { isSafeAmendment } from '../dist/lib/identity.js';
import { mkTmp, rmrf } from './helpers.mjs';

const OWNER = '<!-- ccxlog-owner:ccxlog; kind:aggregate; mode:both -->';
function agg(blocks) {
  return [OWNER, '<!-- notice -->', '# ccxlog', '', '- Project: x', '- Source: Codex', '', '', blocks].join('\n');
}
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccc';
const block = (id, body = 'content') => `<!-- ccxlogid:${id} -->\n# 2026/05/27 Wed 11:03:49\n${body}\n\n`;

// Mirrors the real live-session case: the pair is rendered before the session
// answered, so Model / Tokens / Answer are still empty.
const unfinished = (id) => [
  `<!-- ccxlogid:${id} -->`,
  '# 2026/07/24 Fri 17:43:08   [ClaudeCode] Session:Claude1:7a7f3581',
  'Model= Version=2.1.170',
  'Tokens=',
  '## Question',
  '1でいきましょう。',
  '',
  '<!--',
  '## Answer',
  '',
  '-->',
  '',
].join('\n');
const finished = (id) => [
  `<!-- ccxlogid:${id} -->`,
  '# 2026/07/24 Fri 17:43:08   [ClaudeCode] Session:Claude1:7a7f3581',
  'Model=claude-opus-4-8 Version=2.1.170',
  'Tokens=in 135, out 1,907, cache read 2,039,101, cache write 880',
  '## Question',
  '1でいきましょう。',
  '',
  '<!--',
  '## Answer',
  '監視をバックグラウンドで起動しました。',
  '',
  '-->',
  '',
].join('\n');

test('isSafeAmendment: unfinished tail pair filled in + appended blocks', () => {
  const oldRegion = block(A) + unfinished(B);
  const newRegion = block(A) + finished(B) + block(C);
  assert.equal(isSafeAmendment(oldRegion, newRegion), true);
});

test('isSafeAmendment: pure append alone also qualifies', () => {
  assert.equal(isSafeAmendment(block(A), block(A) + block(B)), true);
});

test('isSafeAmendment: rejects a dropped block', () => {
  assert.equal(isSafeAmendment(block(A) + block(B), block(A)), false);
});

test('isSafeAmendment: rejects a block inserted mid-sequence', () => {
  assert.equal(isSafeAmendment(block(A) + block(B), block(A) + block(C) + block(B)), false);
});

test('isSafeAmendment: rejects reordered blocks', () => {
  assert.equal(isSafeAmendment(block(A) + block(B), block(B) + block(A)), false);
});

test('isSafeAmendment: rejects substituted content (not insertion-only)', () => {
  // "content" -> "Content": one character substituted, old text not a subsequence.
  assert.equal(isSafeAmendment(block(A, 'content'), block(A, 'Content')), false);
});

test('isSafeAmendment: rejects deleted characters inside a block', () => {
  assert.equal(isSafeAmendment(block(A, 'content'), block(A, 'cont')), false);
});

test('isSafeAmendment: rejects when text before the first marker differs', () => {
  assert.equal(isSafeAmendment('intro\n' + block(A), 'INTRO\n' + block(A) + block(B)), false);
});

test('planWrite: live-session completion plans as amend without backup', async () => {
  const dir = mkTmp('ccx-amend-');
  const file = path.join(dir, 'ccxlog.md');
  try {
    const before = agg(block(A) + unfinished(B));
    await commitPlan((await planWrite(file, before, 'aggregate')).plan, { dryRun: false, alreadyBackedUp: false });
    const after = agg(block(A) + finished(B) + block(C));
    const plan = (await planWrite(file, after, 'aggregate')).plan;
    assert.equal(plan.outcome, 'amend');
    assert.equal(plan.backupRequired, false);
    assert.equal((await commitPlan(plan, { dryRun: false, alreadyBackedUp: false })).result, 'amend');
    assert.equal(fs.readFileSync(file, 'utf-8'), after); // amend reproduced full content
  } finally { rmrf(dir); }
});

test('planWrite: a reworded old block still plans as backed-up rewrite', async () => {
  const dir = mkTmp('ccx-amend-');
  const file = path.join(dir, 'ccxlog.md');
  try {
    await commitPlan((await planWrite(file, agg(block(A) + block(B)), 'aggregate')).plan, { dryRun: false, alreadyBackedUp: false });
    const plan = (await planWrite(file, agg(block(A, 'REWORDED body') + block(B) + block(C)), 'aggregate')).plan;
    assert.equal(plan.outcome, 'rewrite');
    assert.equal(plan.backupRequired, true);
  } finally { rmrf(dir); }
});
