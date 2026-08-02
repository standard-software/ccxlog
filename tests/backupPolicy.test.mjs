import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planWrite, commitPlan } from '../dist/lib/markdownWriter.js';
import { isDestructive, chooseMethod } from '../dist/lib/identity.js';
import { mkTmp, rmrf } from './helpers.mjs';

const OWNER = '<!-- ccxlog-owner:ccxlog; kind:aggregate; mode:both -->';
function agg(blocks) {
  return [OWNER, '<!-- notice -->', '# ccxlog', '', '- Project: x', '- Source: Codex', '', '', blocks].join('\n');
}
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccc';
const block = (id, body = 'content') => `<!-- ccxlogid:${id} -->\n# 2026/05/27 Wed 11:03:49\n${body}\n\n`;

const unfinished = (id) => [
  `<!-- ccxlogid:${id} -->`,
  '# 2026/07/24 Fri 17:43:08   [ClaudeCode] Session:Claude1:7a7f3581',
  'Model= Version=2.1.170',
  'Tokens=',
  '## Question',
  'Let us go with option 1.',
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
  'Let us go with option 1.',
  '',
  '<!--',
  '## Answer',
  'Started monitoring in the background.',
  '',
  '-->',
  '',
].join('\n');

async function planFor(existing, next) {
  const dir = mkTmp('ccx-bkp-');
  const file = path.join(dir, 'ccxlog.md');
  try {
    fs.writeFileSync(file, existing, 'utf-8');
    const res = await planWrite(file, next, 'aggregate');
    assert.equal(res.ok, true, res.ok ? '' : res.error);
    return res.plan;
  } finally { rmrf(dir); }
}

test('R2: replacing content with the same ID rewrites without a backup', async () => {
  const plan = await planFor(agg(block(A, 'content')), agg(block(A, 'REWORDED body')));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, false);
});

test('R2: inserting a new pair into the timeline does not require a backup', async () => {
  const plan = await planFor(agg(block(A) + block(B)), agg(block(A) + block(C) + block(B)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, false);
});

test('R2: reordering pairs does not require a backup', async () => {
  const plan = await planFor(agg(block(A) + block(B)), agg(block(B) + block(A)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, false);
});

test('R2: filling an incomplete pair and appending does not require a backup', async () => {
  const dir = mkTmp('ccx-bkp-');
  const file = path.join(dir, 'ccxlog.md');
  try {
    fs.writeFileSync(file, agg(block(A) + unfinished(B)), 'utf-8');
    const after = agg(block(A) + finished(B) + block(C));
    const plan = (await planWrite(file, after, 'aggregate')).plan;
    assert.equal(plan.outcome, 'rewrite');
    assert.equal(plan.backupRequired, false);
    assert.equal((await commitPlan(plan, { dryRun: false, alreadyBackedUp: false })).result, 'rewrite');
    assert.equal(fs.readFileSync(file, 'utf-8'), after);
  } finally { rmrf(dir); }
});

test('R2: a rewrite that loses any ID requires a backup', async () => {
  const plan = await planFor(agg(block(A) + block(B)), agg(block(A) + block(C)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, true);
});

test('R2-2: old content without a valid ccxlogid is indeterminate and requires a backup', async () => {
  const plan = await planFor(agg('body without an id\n'), agg(block(A)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, true);
});

test('R2-2: a malformed ccxlogid in old content is indeterminate and requires a backup', async () => {
  const plan = await planFor(agg('<!-- ccxlogid:not-a-real-id -->\nbody\n' + block(A)), agg(block(A) + block(B)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, true);
});

test('R2-2: duplicate IDs in old content are indeterminate and require a backup', async () => {
  const plan = await planFor(agg(block(A) + block(A)), agg(block(A) + block(B)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, true);
});

test('R2-2: an ID parse failure in new content is indeterminate and requires a backup', async () => {
  const plan = await planFor(agg(block(A)), agg('<!-- ccxlogid:broken -->\nbody\n' + block(B)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, true);
});

test('isDestructive: method none is always conservative and returns true', () => {
  const oldBody = agg(block(A));
  assert.equal(chooseMethod(oldBody, 'no ids at all').method, 'none');
  assert.equal(isDestructive(oldBody, 'no ids at all', 'none'), true);
});


test('R4-2: per-session output backs up only when IDs are lost', async () => {
  const dir = mkTmp('ccx-bkp-session-');
  const file = path.join(dir, 'session.md');
  const owner = '<!-- ccxlog-owner:ccxlog; kind:session; source:claude; sid64:cw -->';
  const session = (blocks) => [owner, '<!-- notice -->', blocks].join('\n');
  try {
    fs.writeFileSync(file, session(block(A) + block(B)), 'utf-8');
    const kept = (await planWrite(file, session(block(B) + block(A)), 'session')).plan;
    assert.equal(kept.outcome, 'rewrite');
    assert.equal(kept.backupRequired, false);
    const lost = (await planWrite(file, session(block(A)), 'session')).plan;
    assert.equal(lost.outcome, 'rewrite');
    assert.equal(lost.backupRequired, true);
  } finally { rmrf(dir); }
});


test('R2-4: commitPlan creates a JIT backup before a replanned rewrite that loses IDs', async () => {
  const dir = mkTmp('ccx-bkp-jit-');
  const file = path.join(dir, 'ccxlog.md');
  const backupDir = path.join(dir, 'bak');
  try {
    await commitPlan((await planWrite(file, agg(block(A)), 'aggregate')).plan, { dryRun: false, alreadyBackedUp: false });
    const next = agg(block(A) + block(B));
    const plan = (await planWrite(file, next, 'aggregate')).plan;
    assert.equal(plan.outcome, 'append');
    assert.equal(plan.backupRequired, false);
    const external = agg(block(A) + block(C));
    fs.writeFileSync(file, external, 'utf-8');
    const res = await commitPlan(plan, { dryRun: false, alreadyBackedUp: false, backupDir });
    assert.equal(res.error, undefined);
    assert.equal(res.result, 'rewrite');
    assert.equal(fs.readFileSync(path.join(backupDir, 'ccxlog.md'), 'utf-8'), external);
    assert.equal(fs.readFileSync(file, 'utf-8'), next);
  } finally { rmrf(dir); }
});

test('R2-4: a replanned rewrite that preserves IDs does not create a JIT backup', async () => {
  const dir = mkTmp('ccx-bkp-jit-');
  const file = path.join(dir, 'ccxlog.md');
  const backupDir = path.join(dir, 'bak');
  try {
    const next = agg(block(A) + block(B));
    await commitPlan((await planWrite(file, next, 'aggregate')).plan, { dryRun: false, alreadyBackedUp: false });
    const plan = (await planWrite(file, next, 'aggregate')).plan;
    assert.equal(plan.outcome, 'noop');
    fs.writeFileSync(file, agg(block(B) + block(A)), 'utf-8');
    const res = await commitPlan(plan, { dryRun: false, alreadyBackedUp: false, backupDir });
    assert.equal(res.error, undefined);
    assert.equal(res.result, 'rewrite');
    assert.equal(fs.existsSync(backupDir), false);
    assert.equal(fs.readFileSync(file, 'utf-8'), next);
  } finally { rmrf(dir); }
});
