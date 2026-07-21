import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  planWrite, commitPlan, fingerprintChanged, backupAndVerify, contentHashOf,
  formatDateTime, buildAggregatePreamble, toUnifiedPair,
} from '../dist/lib/markdownWriter.js';
import { mkTmp, rmrf } from './helpers.mjs';

const OWNER = '<!-- ccxlog-owner:ccxlog; kind:aggregate; mode:both -->';
function agg(blocks) {
  return [OWNER, '<!-- notice -->', '# ccxlog', '', '- Project: x', '- Source: Codex', '', '', blocks].join('\n');
}
const block = (id) => `<!-- ccxlogid:${id} -->\n# 2026/05/27 Wed 11:03:49\ncontent\n\n`;
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function tmpFile() {
  const dir = mkTmp('ccx-mw-');
  return { dir, file: path.join(dir, 'ccxlog.md') };
}

test('smart-write: create then noop', async () => {
  const { dir, file } = tmpFile();
  try {
    const content = agg(block(A));
    let plan = (await planWrite(file, content, 'aggregate')).plan;
    assert.equal(plan.outcome, 'create');
    assert.equal((await commitPlan(plan, { dryRun: false, alreadyBackedUp: false })).result, 'create');
    plan = (await planWrite(file, content, 'aggregate')).plan;
    assert.equal(plan.outcome, 'noop');
  } finally { rmrf(dir); }
});

test('smart-write: append when new content strictly extends old', async () => {
  const { dir, file } = tmpFile();
  try {
    const one = agg(block(A));
    await commitPlan((await planWrite(file, one, 'aggregate')).plan, { dryRun: false, alreadyBackedUp: false });
    const two = agg(block(A) + block(B));
    const plan = (await planWrite(file, two, 'aggregate')).plan;
    assert.equal(plan.outcome, 'append');
    assert.equal((await commitPlan(plan, { dryRun: false, alreadyBackedUp: false })).result, 'append');
    assert.equal(fs.readFileSync(file, 'utf-8'), two); // append reproduced full content
  } finally { rmrf(dir); }
});

test('smart-write: dropping a block id is a destructive rewrite', async () => {
  const { dir, file } = tmpFile();
  try {
    await commitPlan((await planWrite(file, agg(block(A) + block(B)), 'aggregate')).plan, { dryRun: false, alreadyBackedUp: false });
    const plan = (await planWrite(file, agg(block(A)), 'aggregate')).plan;
    assert.equal(plan.outcome, 'rewrite');
    assert.equal(plan.destructive, true);
  } finally { rmrf(dir); }
});

test('smart-write: template-only change keeps ids -> non-destructive rewrite', async () => {
  const { dir, file } = tmpFile();
  try {
    await commitPlan((await planWrite(file, agg(block(A)), 'aggregate')).plan, { dryRun: false, alreadyBackedUp: false });
    const reworded = agg(`<!-- ccxlogid:${A} -->\n# 2026/05/27 Wed 11:03:49\nDIFFERENT body\n\n`);
    const plan = (await planWrite(file, reworded, 'aggregate')).plan;
    assert.equal(plan.outcome, 'rewrite');
    assert.equal(plan.destructive, false); // id A still present
  } finally { rmrf(dir); }
});

test('migration from the removed marker format is a destructive rewrite', async () => {
  const { dir, file } = tmpFile();
  try {
    const old = agg(`<!-- ccxlog-pair:ccxid:${A} -->\n# 2026/05/27 Wed 11:03:49\ncontent\n\n`);
    fs.writeFileSync(file, old, 'utf-8');
    const plan = (await planWrite(file, agg(block(A)), 'aggregate')).plan;
    assert.equal(plan.outcome, 'rewrite');
    assert.equal(plan.destructive, true);
  } finally { rmrf(dir); }
});

test('ownership: an unconfirmed same-name file is not overwritten', async () => {
  const { dir, file } = tmpFile();
  try {
    fs.writeFileSync(file, 'a user file that ccxlog did not create\n', 'utf-8');
    const res = await planWrite(file, agg(block(A)), 'aggregate');
    assert.equal(res.ok, false);
    assert.match(res.error, /ownership-unconfirmed/i);
  } finally { rmrf(dir); }
});

test('re-check detects a same-size, same-mtime edit in the MIDDLE of the file', async () => {
  const { dir, file } = tmpFile();
  try {
    // Make a long body so the edit lands well past the old head/tail 1KB window
    // that the previous fast-hash could not see (the r3-report blind spot).
    const long = agg('x'.repeat(4096) + block(A) + 'y'.repeat(4096));
    fs.writeFileSync(file, long, 'utf-8');
    const st = fs.statSync(file);
    const fp = (await planWrite(file, agg(block(B)), 'aggregate')).plan.fingerprint;
    assert.ok(fp);
    // Flip a single byte in the exact middle; keep length and mtime identical.
    const original = fs.readFileSync(file, 'utf-8');
    const mid = Math.floor(original.length / 2);
    const edited = original.slice(0, mid) + (original[mid] === 'z' ? 'Z' : 'z') + original.slice(mid + 1);
    assert.equal(edited.length, original.length);
    fs.writeFileSync(file, edited, 'utf-8');
    fs.utimesSync(file, st.atime, st.mtime);
    assert.equal(await fingerprintChanged(file, fp), true); // caught by full content hash
  } finally { rmrf(dir); }
});

test('contentHashOf: differs on content change, stable on identical content', () => {
  assert.equal(contentHashOf('hello world'), contentHashOf('hello world'));
  assert.notEqual(contentHashOf('hello world'), contentHashOf('hello worlX'));
});

test('commit: a planned noop is re-checked and corrected if the file changed under us (§8.5)', async () => {
  const { dir, file } = tmpFile();
  try {
    const full = agg(block(A) + block(B));
    // Create the full file, then plan again: identical -> noop.
    await commitPlan((await planWrite(file, full, 'aggregate')).plan, { dryRun: false, alreadyBackedUp: false });
    const noopPlan = (await planWrite(file, full, 'aggregate')).plan;
    assert.equal(noopPlan.outcome, 'noop');
    // An external process truncates the file to just block A between plan and commit.
    fs.writeFileSync(file, agg(block(A)), 'utf-8');
    // Committing the "noop" must NOT report noop; it re-plans and converges the
    // file back to the full planned content instead of silently leaving it wrong.
    const res = await commitPlan(noopPlan, { dryRun: false, alreadyBackedUp: false, backupDir: path.join(dir, 'bak') });
    assert.notEqual(res.result, 'noop');
    assert.equal(fs.readFileSync(file, 'utf-8'), full);
  } finally { rmrf(dir); }
});

test('buildAnswer: a progress-only (developer) entry is never promoted to %Answer% (§6.2)', () => {
  // Interrupted turn: no final answer, only a progress-only developer message.
  const pair = {
    questionEntry: { type: 'user', uuid: 'u1', timestamp: '2026-05-27T11:00:00Z', message: { role: 'user', content: 'Q' } },
    additionalQuestionEntries: [],
    progressEntries: [
      { type: 'assistant', uuid: 'a1', timestamp: '2026-05-27T11:00:01Z', isProgressOnly: true,
        message: { role: 'assistant', content: [{ type: 'text', text: '[Developer] internal note' }] } },
    ],
    finalAssistantEntry: null,
  };
  const u = toUnifiedPair({
    pair, source: 'codex', sourceLabel: 'Codex', sessionId: 's', sessionName: '',
    sourceFile: '/x.jsonl', sourceFileRelativeId: 'codex/standard/std/x.jsonl',
    fileContentHash: '', eventIdStreamHash: [], questionOrdinal: 0,
  });
  assert.equal(u.answer, '', 'developer/progress-only text must not become the answer');
});

test('formatDateTime: unparseable raw timestamp is stripped of DEL/C1 controls (§8.3)', () => {
  const out = formatDateTime({ questionTimestampMs: null, questionTimestampRaw: 'a\x7fb\x85c' });
  assert.equal(out, 'abc');
});

test('backupAndVerify: copies and verifies via SHA-256', async () => {
  const { dir, file } = tmpFile();
  try {
    fs.writeFileSync(file, 'some content\n', 'utf-8');
    const backupDir = path.join(dir, 'backup');
    assert.equal(await backupAndVerify(file, backupDir), true);
    assert.equal(fs.readFileSync(path.join(backupDir, 'ccxlog.md'), 'utf-8'), 'some content\n');
  } finally { rmrf(dir); }
});

test('formatDateTime: valid, unparseable-with-raw, and empty', () => {
  assert.equal(formatDateTime({ questionTimestampMs: Date.parse('2026-05-27T11:03:49Z'), questionTimestampRaw: '2026-05-27T11:03:49Z' }).length, '2026/05/27 Wed 11:03:49'.length);
  assert.equal(formatDateTime({ questionTimestampMs: null, questionTimestampRaw: 'weird -->time' }), 'weird -- >time');
  assert.equal(formatDateTime({ questionTimestampMs: null, questionTimestampRaw: '' }), 'Unknown');
});

test('preamble: fixed ownership marker carries the mode', () => {
  const pre = buildAggregatePreamble('claude', 'C:/proj', 'cclog.md', ['ClaudeCode']);
  assert.ok(pre.startsWith('<!-- ccxlog-owner:ccxlog; kind:aggregate; mode:claude -->'));
});

// ---- ports from old-develop unit-writer.test.mjs ---------------------------

test('smart-write: a volatile preamble-only change alone is still a noop', async () => {
  const { dir, file } = tmpFile();
  try {
    await commitPlan((await planWrite(file, agg(block(A)), 'aggregate')).plan, { dryRun: false, alreadyBackedUp: false });
    // Same owner marker + same block region, only a preamble meta value changed.
    const other = agg(block(A)).replace('- Project: x', '- Project: y');
    const plan = (await planWrite(file, other, 'aggregate')).plan;
    assert.equal(plan.outcome, 'noop');
  } finally { rmrf(dir); }
});

test('ownership: a legacy generated header counts as owned (migration, no refusal)', async () => {
  const { dir, file } = tmpFile();
  try {
    fs.writeFileSync(file, '# ccxlog\n\nlegacy body\n', 'utf-8');
    const res = await planWrite(file, agg(block(A)), 'aggregate');
    assert.equal(res.ok, true, 'a legacy "# ccxlog" header is recognized as ours');
  } finally { rmrf(dir); }
});

test('ownership: a BOM-prefixed owned file is still recognized as owned (§CC#11)', async () => {
  const { dir, file } = tmpFile();
  try {
    // An external editor prepended a UTF-8 BOM to a file we generated.
    fs.writeFileSync(file, '﻿' + agg(block(A)), 'utf-8');
    const res = await planWrite(file, agg(block(A)), 'aggregate');
    assert.equal(res.ok, true, 'the BOM must not hide our ownership');
    assert.equal(res.plan.outcome, 'rewrite'); // only the BOM differs -> clean rewrite
  } finally { rmrf(dir); }
});

test('ownership: a CRLF-on-disk file is rewritten to LF, never appended onto (§CC#7)', async () => {
  const { dir, file } = tmpFile();
  try {
    // Same owned content, but stored with CRLF line endings.
    fs.writeFileSync(file, agg(block(A)).replace(/\n/g, '\r\n'), 'utf-8');
    // New content strictly extends the old — would be an append on an LF file.
    const res = await planWrite(file, agg(block(A) + block(B)), 'aggregate');
    assert.equal(res.ok, true);
    assert.equal(res.plan.outcome, 'rewrite', 'must not append LF bytes onto a CRLF file');
    await commitPlan(res.plan, { dryRun: false, alreadyBackedUp: true, backupDir: path.join(dir, 'bak') });
    assert.equal(fs.readFileSync(file, 'utf-8').includes('\r'), false, 'result must be LF-only');
  } finally { rmrf(dir); }
});

test('progress: summary vs full render independently (thinking only in the full dump)', () => {
  const pair = {
    questionEntry: { type: 'user', uuid: 'u1', timestamp: '2026-05-27T11:00:00Z', message: { role: 'user', content: 'Q' } },
    additionalQuestionEntries: [],
    progressEntries: [
      { type: 'assistant', uuid: 'p1', timestamp: '2026-05-27T11:00:01Z', isProgressOnly: true,
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret reasoning' }] } },
    ],
    finalAssistantEntry: { type: 'assistant', uuid: 'a1', timestamp: '2026-05-27T11:00:02Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
  };
  const u = toUnifiedPair({
    pair, source: 'claude', sourceLabel: 'ClaudeCode', sessionId: 's', sessionName: '',
    sourceFile: '/x.jsonl', sourceFileRelativeId: 'claude/standard/std/x.jsonl',
    fileContentHash: '', eventIdStreamHash: [], questionOrdinal: 0,
  });
  // Thinking is surfaced only in the full dump, never the summary.
  assert.doesNotMatch(u.progressSummary, /Thinking|secret reasoning/);
  assert.match(u.progressFull, /Thinking/);
  assert.match(u.progressFull, /secret reasoning/);
});
