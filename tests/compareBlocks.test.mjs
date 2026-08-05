// tools/compare-blocks.mjs is the fixed, re-runnable procedure behind
// § requirement 11's last condition ("for every block that disappeared, be able
// to state why"). It is verification machinery, so it needs verifying too: a
// classifier that quietly explains everything would pass a release that
// corrupted the output.
//
// The case that matters most here is the one the first version of the tool
// could not see at all. An earlier generation of this feature replaced a parent
// block's ANSWER with a child's while the block kept its ccxlogid; the tool
// skipped every surviving id, so it reported zero differences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkTmp, rmrf, ROOT } from './helpers.mjs';

const TOOL = path.join(ROOT, 'tools', 'compare-blocks.mjs');

function block({
  id, question, answer = '', progress = null, tokens = 'in 10, out 20',
  session = 'parent session', sessionId = '11111111-1111-4111-8111-111111111111',
  datetime = '2026/05/27 Wed 19:00:00', source = 'Codex',
}) {
  return [
    `<!-- ccxlogid:${id} -->`,
    `# ${datetime}   [${source}] Session:${session}:${sessionId}`,
    'Model=gpt-5 Version=0.144.6',
    'Branch=main Cwd=/proj',
    `Tokens=${tokens}`,
    '## Question',
    question,
    ...(progress ? ['## Progress', ...progress] : []),
    '## Answer',
    answer,
    '',
    '----------------------------------------',
    '',
    '',
  ].join('\n');
}

function doc(...blocks) {
  return '<!-- ccxlog-owner:ccxlog; kind:aggregate; mode:codex -->\n# cxlog\n\n' + blocks.join('');
}

function compare(t, oldDoc, newDoc) {
  const dir = mkTmp('ccx-cmp-');
  t.after(() => rmrf(dir));
  const a = path.join(dir, 'old.md');
  const b = path.join(dir, 'new.md');
  fs.writeFileSync(a, oldDoc, 'utf-8');
  fs.writeFileSync(b, newDoc, 'utf-8');
  const r = spawnSync(process.execPath, [TOOL, a, b], { encoding: 'utf-8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ID_C = 'cccccccccccccccccccccccc';

test('cmp 1: an identical pair of outputs is all-unchanged and exits 0', (t) => {
  const d = doc(block({ id: ID_A, question: 'Q1', answer: 'A1' }));
  const r = compare(t, d, d);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /unchanged: 1/);
  assert.match(r.stdout, /MUTATED: 0/);
});

test('cmp 2: an answer swapped under a surviving ccxlogid is MUTATED, and fails', (t) => {
  // The exact corruption the question-text-only comparison passed: same id,
  // same question, the answer replaced by another copy's.
  const before = doc(block({ id: ID_A, question: 'Q1', answer: 'Parent answer' }));
  const after = doc(block({ id: ID_A, question: 'Q1', answer: 'Child interim note' }));
  const r = compare(t, before, after);
  assert.equal(r.code, 1, 'a replaced answer must fail the check');
  assert.match(r.stdout, /MUTATED: 1/);
  assert.match(r.stdout, /answer: "Parent answer" -> "Child interim note"/);
});

test('cmp 3: gaining an answer under a surviving id is enrichment, not mutation', (t) => {
  // The intended shape of the merge: the original pair had only a question and
  // the copy's answer moved into it. Nothing was overwritten.
  const before = doc(block({ id: ID_A, question: 'Q1', answer: '' }));
  const after = doc(block({ id: ID_A, question: 'Q1', answer: 'The answer' }));
  const r = compare(t, before, after);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /enriched: 1/);
  assert.match(r.stdout, /answer gained/);
});

test('cmp 4: progress and tokens are compared too — growth passes, loss fails', (t) => {
  const before = doc(block({
    id: ID_A, question: 'Q1', answer: 'A1',
    progress: ['- [Tool: shell] one'], tokens: 'in 10, out 20',
  }));
  const grew = doc(block({
    id: ID_A, question: 'Q1', answer: 'A1',
    progress: ['- [Tool: shell] one', '- [Tool: shell] two'], tokens: 'in 10, out 99',
  }));
  const ok = compare(t, before, grew);
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, /progress 1 -> 2/);
  assert.match(ok.stdout, /tokens\.out 20 -> 99/);

  // Progress that no longer contains what was there, and a token count that
  // went backwards, are both losses.
  const lost = doc(block({
    id: ID_A, question: 'Q1', answer: 'A1',
    progress: ['- [Tool: shell] something else'], tokens: 'in 10, out 5',
  }));
  const bad = compare(t, before, lost);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /progress no longer contains what it had/);
  assert.match(bad.stdout, /tokens\.out shrank 20 -> 5/);
});

test('cmp 5: a moved session or timestamp under a surviving id is MUTATED', (t) => {
  // A block whose id survived may not change WHERE or WHEN it claims to be
  // from: that would mean the child's rewritten identity replaced the parent's.
  const before = doc(block({ id: ID_A, question: 'Q1', answer: 'A1' }));
  const after = doc(block({
    id: ID_A, question: 'Q1', answer: 'A1',
    session: 'reviewer', sessionId: '22222222-2222-4222-8222-222222222222',
    datetime: '2026/05/27 Wed 21:00:00',
  }));
  const r = compare(t, before, after);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /sessionId: /);
  assert.match(r.stdout, /datetime: /);
});

test('cmp 6: a removed re-recording is duplicate-removed, and a lost one is UNEXPLAINED', (t) => {
  // Two copies of the same Q&A go down to one: explained.
  const before = doc(
    block({ id: ID_A, question: 'Q1', answer: 'A1' }),
    block({ id: ID_B, question: 'Q1', answer: 'A1' }),
  );
  const after = doc(block({ id: ID_A, question: 'Q1', answer: 'A1' }));
  const ok = compare(t, before, after);
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, /duplicate-removed: 1/);
  assert.match(ok.stdout, /UNEXPLAINED: 0/);

  // A block whose question survives but whose ANSWER is nowhere is NOT a
  // duplicate. Counting question text alone called this explained.
  const lossy = doc(block({ id: ID_A, question: 'Q1', answer: 'A1' }));
  const bad = compare(
    t,
    doc(block({ id: ID_A, question: 'Q1', answer: 'A1' }), block({ id: ID_B, question: 'Q1', answer: 'A DIFFERENT answer' })),
    lossy,
  );
  assert.equal(bad.code, 1, 'a dropped answer must not be waved through');
  assert.match(bad.stdout, /UNEXPLAINED: 1/);
});

test('cmp 7: the same question genuinely asked twice is not read as a duplicate', (t) => {
  // Both copies keep their ids, so nothing is gone at all — the old tool would
  // not have looked, and the new one confirms both survived unchanged.
  const before = doc(
    block({ id: ID_A, question: 'Q1', answer: 'A1' }),
    block({ id: ID_B, question: 'Q1', answer: 'A2' }),
  );
  const after = doc(
    block({ id: ID_A, question: 'Q1', answer: 'A1' }),
    block({ id: ID_C, question: 'Q1', answer: 'A2' }),
  );
  const r = compare(t, before, after);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /unchanged: 1/);
  // The second one only changed id — its question AND answer are both still
  // there, so it is an id change and not a removal.
  assert.match(r.stdout, /id-changed: 1/);
  assert.match(r.stdout, /duplicate-removed: 0/);
});

test('cmp 8: an instruction block the old version never rendered is its own bucket', (t) => {
  const before = doc(block({ id: ID_A, question: 'Q1', answer: 'A1' }));
  const after = doc(
    block({ id: ID_A, question: 'Q1', answer: 'A1' }),
    block({ id: ID_B, question: 'Message Type: NEW_TASK\nSender: /root', answer: 'Child answer' }),
  );
  const r = compare(t, before, after);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /instruction: 1/);
  assert.match(r.stdout, /new-content: 0/);
});
