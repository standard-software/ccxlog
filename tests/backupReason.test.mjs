// The record ccxlog leaves inside an automatic backup folder explaining why the
// backup happened. An automatic backup only ever appears because blocks were
// about to be lost, and the folder alone cannot say which blocks or why; these
// tests pin that the explanation is written, is accurate, and never becomes a
// reason for the run itself to fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planWrite, backupAndVerify } from '../dist/lib/markdownWriter.js';
import { renderBackupReason, BACKUP_REASON_FILE } from '../dist/lib/backup.js';
import {
  mkTmp, rmrf, workspace, writeConfig, writeJsonl, read, exists, claudeQA, run, countPairs,
} from './helpers.mjs';

const OWNER = '<!-- ccxlog-owner:ccxlog; kind:aggregate; mode:both -->';
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccc';

function agg(blocks) {
  return [OWNER, '<!-- notice -->', '# ccxlog', '', '- Project: x', '', '', blocks].join('\n');
}
const block = (id, head = '# 2026/05/27 Wed 11:03:49   [ClaudeCode] Session:Claude1:7a7f3581') =>
  `<!-- ccxlogid:${id} -->\n${head}\n## Question\nsomething\n\n`;

async function planFor(existing, next) {
  const dir = mkTmp('ccx-reason-');
  const file = path.join(dir, 'ccxlog.md');
  try {
    fs.writeFileSync(file, existing, 'utf-8');
    const res = await planWrite(file, next, 'aggregate');
    assert.equal(res.ok, true, res.ok ? '' : res.error);
    return res.plan;
  } finally { rmrf(dir); }
}

// ---- what planning records -------------------------------------------------

test('reason 1: a rewrite that drops a block names the id and its first line', async () => {
  const plan = await planFor(agg(block(A) + block(B)), agg(block(A)));
  assert.equal(plan.backupRequired, true);
  assert.equal(plan.backupReason.kind, 'ids-lost');
  assert.equal(plan.backupReason.oldCount, 2);
  assert.equal(plan.backupReason.newCount, 1);
  assert.deepEqual(plan.backupReason.lost.map(l => l.id), [`ccxlogid:${B}`]);
  assert.match(plan.backupReason.lost[0].label, /2026\/05\/27 Wed 11:03:49/);
});

test('reason 2: no backup, no reason — a preserved rewrite records nothing', async () => {
  const plan = await planFor(agg(block(A)), agg(block(A, '# CHANGED HEADING')));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, false);
  assert.equal(plan.backupReason, null);
});

test('reason 3: every lost block is listed, in the order the old file held them', async () => {
  const plan = await planFor(agg(block(A) + block(B) + block(C)), agg(block(B)));
  assert.deepEqual(plan.backupReason.lost.map(l => l.id), [`ccxlogid:${A}`, `ccxlogid:${C}`]);
});

test('reason 4: an undecidable comparison says which side could not be read', async () => {
  // Duplicate ids in the old file: chooseMethod gives up, the backup is taken on
  // the safe side, and the reason must say so rather than list zero lost blocks.
  const plan = await planFor(agg(block(A) + block(A)), agg(block(A)));
  assert.equal(plan.backupRequired, true);
  assert.equal(plan.backupReason.kind, 'undecidable');
  assert.match(plan.backupReason.detail, /duplicate or malformed/);
});

test('reason 5: a block with nothing after its marker is still reported', async () => {
  const trailing = `<!-- ccxlogid:${B} -->\n`;
  const plan = await planFor(agg(block(A) + trailing), agg(block(A)));
  assert.deepEqual(plan.backupReason.lost.map(l => l.id), [`ccxlogid:${B}`]);
  assert.equal(plan.backupReason.lost[0].label, '');
  const text = renderBackupReason('/x/ccxlog.md', plan.backupReason, '9.9.9', new Date());
  assert.match(text, /\(no content after the marker\)/);
});

// ---- what lands in the backup folder ---------------------------------------

test('reason 6: a verified backup writes the record; a second one appends under one header', async () => {
  const dir = mkTmp('ccx-reason-');
  try {
    const one = path.join(dir, 'one.md');
    const two = path.join(dir, 'two.md');
    fs.writeFileSync(one, 'content one', 'utf-8');
    fs.writeFileSync(two, 'content two', 'utf-8');
    const backupDir = path.join(dir, 'backup');
    const note = kind => ({
      version: '9.9.9',
      reason: kind === 'del'
        ? { kind: 'file-deleted' }
        : { kind: 'ids-lost', oldCount: 2, newCount: 1, lost: [{ id: `ccxlogid:${B}`, label: '# a lost heading' }] },
    });

    assert.equal(await backupAndVerify(one, backupDir, note('ids')), true);
    assert.equal(await backupAndVerify(two, backupDir, note('del')), true);

    const text = read(path.join(backupDir, BACKUP_REASON_FILE));
    assert.equal(text.split('ccxlog automatic backup').length - 1, 1, 'header written exactly once');
    assert.match(text, /one\.md/);
    assert.match(text, /two\.md/);
    assert.match(text, /ccxlogid:bbbbbbbbbbbbbbbbbbbbbbbb/);
    assert.match(text, /# a lost heading/);
    assert.match(text, /ccxlog version : 9\.9\.9/);
    assert.match(text, /the output file itself is being removed/);
  } finally { rmrf(dir); }
});

test('reason 7: a backup with no note is still taken, just unexplained', async () => {
  const dir = mkTmp('ccx-reason-');
  try {
    const file = path.join(dir, 'x.md');
    fs.writeFileSync(file, 'body', 'utf-8');
    const backupDir = path.join(dir, 'backup');
    assert.equal(await backupAndVerify(file, backupDir), true);
    assert.equal(read(path.join(backupDir, 'x.md')), 'body');
    assert.equal(exists(path.join(backupDir, BACKUP_REASON_FILE)), false);
  } finally { rmrf(dir); }
});

test('reason 8: a failed backup writes no record — nothing was preserved to explain', async () => {
  const dir = mkTmp('ccx-reason-');
  try {
    const backupDir = path.join(dir, 'backup');
    const missing = path.join(dir, 'does-not-exist.md');
    const ok = await backupAndVerify(missing, backupDir, {
      version: '9.9.9',
      reason: { kind: 'ids-lost', oldCount: 1, newCount: 0, lost: [{ id: `ccxlogid:${A}`, label: 'x' }] },
    });
    assert.equal(ok, false);
    assert.equal(exists(path.join(backupDir, BACKUP_REASON_FILE)), false);
  } finally { rmrf(dir); }
});

// ---- end to end: the real case this exists for ------------------------------

test('reason 9: a source log that disappears leaves its blocks named in the backup folder', t => {
  const ws = workspace(t);
  const keep = path.join(ws.ccLogs, 'keep.jsonl');
  const vanishing = path.join(ws.ccLogs, 'vanishing.jsonl');
  writeJsonl(keep, claudeQA(ws.project, { q: 'question that stays', uuid: 'u-keep' }));
  writeJsonl(vanishing, claudeQA(ws.project, {
    q: 'question that vanishes with its log', uuid: 'u-gone', ts: '2026-05-27T12:00:00.000Z',
  }));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });

  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);
  const md = path.join(ws.out, 'cclog.md');
  assert.equal(countPairs(md), 2);

  // The log is deleted the way a retention sweep deletes it: file gone, the
  // exported Markdown untouched and now the only copy of that conversation.
  fs.rmSync(vanishing);
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(countPairs(md), 1);

  const autoDir = path.join(ws.out, 'backup_CCXLOG_md_auto');
  const stamps = fs.readdirSync(autoDir);
  assert.equal(stamps.length, 1, 'exactly one automatic backup folder');
  const folder = path.join(autoDir, stamps[0]);

  // The copy holds the pair that is now gone from the live file...
  assert.match(read(path.join(folder, 'cclog.md')), /question that vanishes with its log/);
  // ...and the record says so without anyone having to diff the two.
  const reason = read(path.join(folder, BACKUP_REASON_FILE));
  assert.match(reason, /1 block\(s\) present before the rewrite are missing/);
  assert.match(reason, /Blocks {9}: 2 before -> 1 after/);
  assert.match(reason, /2026\/05\/27/, 'the lost block is identified by its heading line');
  assert.match(reason, /cclog\.md/);
});
