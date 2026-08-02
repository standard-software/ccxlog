import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkTmp, rmrf } from './helpers.mjs';
import { forEachLine, READ_CHUNK_BYTES } from '../dist/lib/lineStream.js';
import { lazyFileSha256 } from '../dist/lib/pathUtils.js';
import { toUnifiedPair, formatPair } from '../dist/lib/markdownWriter.js';

function splitReference(content) {
  const parts = content.split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

async function collectLines(file) {
  const lines = [];
  await forEachLine(file, l => { lines.push(l); });
  return lines;
}

const CHUNK = READ_CHUNK_BYTES;

function snapOf(file) {
  const st = fs.statSync(file);
  return { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino };
}

test('lineStream: a newline exactly at a chunk boundary preserves lines', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'boundary-newline.txt');
    const first = 'a'.repeat(CHUNK - 1);
    const content = `${first}\nsecond\nthird`;
    fs.writeFileSync(file, content, 'utf-8');
    const lines = await collectLines(file);
    assert.deepEqual(lines.map(l => l.length), [CHUNK - 1, 6, 5]);
    assert.deepEqual(lines, splitReference(content));
  } finally { rmrf(dir); }
});

test('lineStream: multibyte characters split across chunk boundaries are restored', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'boundary-multibyte.txt');
    const content = `${'x'.repeat(CHUNK - 1)}éUnicode\nsecond line`;
    fs.writeFileSync(file, content, 'utf-8');
    const lines = await collectLines(file);
    assert.deepEqual(lines, splitReference(content));
    assert.ok(lines[0].endsWith('éUnicode'), 'multibyte characters must not be corrupted');
  } finally { rmrf(dir); }
});

test('lineStream: empty lines, CRs, and final newlines match split(\'\\n\') exactly', async () => {
  const dir = mkTmp();
  try {
    for (const content of ['a\n\nb\r\nc', 'a\n', 'a', '', '\n', 'a\nb\n']) {
      const file = path.join(dir, 'small.txt');
      fs.writeFileSync(file, content, 'utf-8');
      assert.deepEqual(await collectLines(file), splitReference(content), JSON.stringify(content));
    }
  } finally { rmrf(dir); }
});

test('lineStream: returning false from onLine stops reading early', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'stop.txt');
    fs.writeFileSync(file, Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n'), 'utf-8');
    const seen = [];
    await forEachLine(file, l => {
      seen.push(l);
      if (seen.length === 3) return false;
      return;
    });
    assert.deepEqual(seen, ['line-0', 'line-1', 'line-2'], 'the callback must not run after stopping');
  } finally { rmrf(dir); }
});

test('lazyFileSha256: an unchanged file returns the correct memoized SHA-256', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'hash.jsonl');
    const body = '{"a":1}\n{"b":2}\n';
    fs.writeFileSync(file, body, 'utf-8');
    const lazy = lazyFileSha256(file, snapOf(file));
    const expected = crypto.createHash('sha256').update(Buffer.from(body, 'utf-8')).digest('hex');
    assert.equal(await lazy(), expected);
    fs.appendFileSync(file, 'more\n');
    assert.equal(await lazy(), expected);
  } finally { rmrf(dir); }
});

test('lazyFileSha256: memoized results remain available after unlink without rereading', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'memo.jsonl');
    const body = 'memoized-content\n';
    fs.writeFileSync(file, body, 'utf-8');
    const lazy = lazyFileSha256(file, snapOf(file));
    const expected = crypto.createHash('sha256').update(Buffer.from(body, 'utf-8')).digest('hex');
    assert.equal(await lazy(), expected);
    fs.unlinkSync(file);
    assert.equal(await lazy(), expected);
  } finally { rmrf(dir); }
});

test('lazyFileSha256: a file changed after parsing returns an empty hash', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'changed.jsonl');
    fs.writeFileSync(file, 'original\n', 'utf-8');
    const snap = snapOf(file);
    fs.appendFileSync(file, 'appended after parse\n');
    const lazy = lazyFileSha256(file, snap);
    assert.equal(await lazy(), '');
  } finally { rmrf(dir); }
});

test('lazyFileSha256: a changed mtime returns an empty hash even when size is unchanged', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'touched.jsonl');
    fs.writeFileSync(file, 'stable content\n', 'utf-8');
    const snap = snapOf(file);
    fs.utimesSync(file, new Date(), new Date(snap.mtimeMs + 5000));
    const lazy = lazyFileSha256(file, snap);
    assert.equal(await lazy(), '');
  } finally { rmrf(dir); }
});

test('lazyFileSha256: dev/ino detects replacement with the same size and mtime', async t => {
  const dir = mkTmp();
  try {
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    fs.writeFileSync(a, 'content-A\n', 'utf-8');
    fs.writeFileSync(b, 'content-B\n', 'utf-8');
    const when = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(a, when, when);
    fs.utimesSync(b, when, when);
    const snap = snapOf(a);
    fs.renameSync(b, a);
    fs.utimesSync(a, when, when);
    const after = snapOf(a);
    if (snap.ino === 0 || after.ino === snap.ino || after.mtimeMs !== snap.mtimeMs) {
      t.skip('this filesystem cannot verify identity using inode values');
      return;
    }
    assert.equal(after.size, snap.size, 'the replacement must have the same size');
    assert.equal(await lazyFileSha256(a, snap)(), '',
      'an inode change must prevent duplicate confirmation even with equal size and mtime');
  } finally { rmrf(dir); }
});

test('lazyFileSha256: an unreadable file returns an empty hash conservatively', async () => {
  const lazy = lazyFileSha256(path.join(mkTmp(), 'no-such-file.jsonl'), { size: 1, mtimeMs: 1, dev: 0, ino: 0 });
  assert.equal(await lazy(), '');
});

function mkCountingPair() {
  const pair = {
    questionEntry: { type: 'user', uuid: 'u1', timestamp: '2026-05-27T11:00:00Z', message: { role: 'user', content: 'Q' } },
    additionalQuestionEntries: [],
    progressEntries: [],
    finalAssistantEntry: { type: 'assistant', uuid: 'a1', timestamp: '2026-05-27T11:00:02Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
  };
  const u = toUnifiedPair({
    pair, source: 'claude', sourceLabel: 'ClaudeCode', sessionId: 's', sessionName: '',
    sourceFile: '/x.jsonl', sourceFileRelativeId: 'claude/standard/std/x.jsonl',
    fileContentHash: async () => '', eventIdStream: [], questionOrdinal: 0,
  });
  const calls = { summary: 0, full: 0 };
  u.progressSummary = () => { calls.summary++; return 'S'; };
  u.progressFull = () => { calls.full++; return 'F'; };
  return { u, calls };
}

test('template gate: templates without Progress do not build progress data', () => {
  const { u, calls } = mkCountingPair();
  const out = formatPair(u, '%Question%\n%Answer%\n');
  assert.match(out, /Q/);
  assert.equal(calls.summary, 0);
  assert.equal(calls.full, 0);
});

test('template gate: %Progress% builds summary only and %ProgressFull% builds full only', () => {
  {
    const { u, calls } = mkCountingPair();
    const out = formatPair(u, '%Question%\n%Progress%\n');
    assert.match(out, /S/);
    assert.equal(calls.summary, 1);
    assert.equal(calls.full, 0, "'%Progress%' detection must not trigger '%ProgressFull%'");
  }
  {
    const { u, calls } = mkCountingPair();
    const out = formatPair(u, '%Question%\n%ProgressFull%\n');
    assert.match(out, /F/);
    assert.equal(calls.summary, 0);
    assert.equal(calls.full, 1);
  }
});
