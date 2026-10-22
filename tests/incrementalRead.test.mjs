// The resumable Claude reader (sources/claude/jsonlReader.ts): reading only
// the lines appended since the last read must give exactly what reading the
// whole file gives — compared here against the pre-1.13.0 algorithm (read every
// line, then build the pairs) at every byte the log could have been cut at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, rmrf } from './helpers.mjs';
import { claudeRecords } from './progressFixture.mjs';

const dist = (...p) => new URL(`../dist/${p.join('/')}`, import.meta.url).href;
const { readClaudeSession } = await import(dist('sources', 'claude', 'jsonlReader.js'));
const { buildPairsSplit, extractSessionName } = await import(dist('sources', 'claude', 'pairBuilder.js'));
const { forEachLine } = await import(dist('lib', 'lineStream.js'));
const { dropProgressData } = await import(dist('lib', 'progressData.js'));

// The reading the resumable reader replaced, kept verbatim as the reference.
async function referenceRead(file, prepare) {
  const entries = [];
  const eventIdStream = [];
  let skipped = 0;
  let formatRecognized = false;
  await forEachLine(file, (line) => {
    if (!line.trim()) return;
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
      if ((entry.type === 'user' || entry.type === 'assistant') && entry.message) formatRecognized = true;
      const id = typeof entry.uuid === 'string' ? entry.uuid : '';
      eventIdStream.push(`${entry.type}\0${id}`);
    } catch {
      skipped++;
    }
  });
  const split = buildPairsSplit(entries);
  prepare(split.main);
  prepare(split.subagent);
  return {
    main: split.main, subagent: split.subagent, sessionName: extractSessionName(entries),
    skippedLines: skipped, eventIdStream, formatRecognized,
  };
}

const comparable = (r) => JSON.stringify({
  main: r.main, subagent: r.subagent, sessionName: r.sessionName,
  skippedLines: r.skippedLines, eventIdStream: r.eventIdStream, formatRecognized: r.formatRecognized,
});

const PROJECT = '/work/proj';

// Every shape the pair builder and the line reader treat specially.
function richLog() {
  const lines = claudeRecords(PROJECT).map(r => JSON.stringify(r));
  const rec = (o) => lines.push(JSON.stringify(o));
  rec({ type: 'ai-title', aiTitle: 'Generated title' });
  // A question typed while the assistant was busy (queued_command).
  rec({ type: 'user', uuid: 'q1', parentUuid: 'x', timestamp: '2026-05-27T12:00:00.000Z', message: { role: 'user', content: '日本語の質問 🚀' } });
  rec({ type: 'attachment', uuid: 'q2', parentUuid: 'q1', timestamp: '2026-05-27T12:00:01.000Z', attachment: { type: 'queued_command', prompt: 'queued while busy' } });
  rec({ type: 'assistant', uuid: 'q3', parentUuid: 'q1', timestamp: '2026-05-27T12:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '答え' }] } });
  rec({ type: 'attachment', uuid: 'q4', parentUuid: 'q3', timestamp: '2026-05-27T12:00:03.000Z', attachment: { type: 'queued_command', prompt: 'queued after the answer' } });
  // Cancel and retype: two questions from the same parent.
  rec({ type: 'user', uuid: 'r1', parentUuid: 'p0', timestamp: '2026-05-27T12:10:00.000Z', message: { role: 'user', content: 'first try' } });
  rec({ type: 'user', uuid: 'r2', parentUuid: 'p0', timestamp: '2026-05-27T12:10:05.000Z', message: { role: 'user', content: 'second try' } });
  rec({ type: 'assistant', uuid: 'r3', parentUuid: 'r2', timestamp: '2026-05-27T12:10:06.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'retyped answer' }] } });
  // Sidechain records interleaved with the main conversation.
  rec({ type: 'user', uuid: 's1', parentUuid: null, isSidechain: true, timestamp: '2026-05-27T12:20:00.000Z', message: { role: 'user', content: 'Sidechain Q' } });
  rec({ type: 'user', uuid: 'm1', parentUuid: 'r3', timestamp: '2026-05-27T12:20:01.000Z', message: { role: 'user', content: 'main again' } });
  rec({ type: 'assistant', uuid: 's2', parentUuid: 's1', isSidechain: true, timestamp: '2026-05-27T12:20:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Sidechain A' }] } });
  rec({ type: 'user', uuid: 'm2', parentUuid: 'm1', isMeta: true, timestamp: '2026-05-27T12:20:03.000Z', message: { role: 'user', content: 'meta follow-up' } });
  rec({ type: 'assistant', uuid: 'm3', parentUuid: 'm1', timestamp: '2026-05-27T12:20:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'main answer' }] } });
  rec({ type: 'custom-title', customTitle: 'Named by the user' });
  // Lines the reader skips or counts.
  lines.push('{ broken json line');
  lines.push('');
  lines.push('   ');
  lines.push('null');
  lines.push('42');
  lines.push('"just a string"');
  lines.push('[1,2]');
  rec({ type: 'user', uuid: 'z1', parentUuid: 'm3', timestamp: '2026-05-27T12:30:00.000Z', message: { role: 'user', content: 'last question' } });
  rec({ type: 'assistant', uuid: 'z2', parentUuid: 'z1', timestamp: '2026-05-27T12:30:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'last answer' }] } });
  return Buffer.from(lines.join('\n') + '\n', 'utf-8');
}

const PREPARES = {
  'Progress dropped': (pairs) => dropProgressData(pairs),
  'Progress kept': () => {},
};

// The cuts that matter are where a line or a character ends, so every byte
// within reach of a newline or of a non-ASCII byte is a cut, plus a sample of
// the rest. (Cutting at literally every byte passes too, but takes minutes.)
function interestingCuts(bytes) {
  const cuts = new Set([0, bytes.length]);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a || bytes[i] >= 0x80) {
      for (let d = -2; d <= 3; d++) if (i + d >= 0 && i + d <= bytes.length) cuts.add(i + d);
    } else if (i % 37 === 0) {
      cuts.add(i);
    }
  }
  return [...cuts].sort((a, b) => a - b);
}

for (const [label, prepare] of Object.entries(PREPARES)) {
  test(`appending piece by piece matches a full read at every line and character boundary (${label})`, async (t) => {
    const dir = mkTmp('ccx-incr-');
    t.after(() => rmrf(dir));
    const file = path.join(dir, 'sess.jsonl');
    const bytes = richLog();
    const cuts = interestingCuts(bytes);
    fs.writeFileSync(file, '');
    let state;
    let written = 0;
    let resumes = 0;
    for (const cut of cuts) {
      fs.appendFileSync(file, bytes.subarray(written, cut));
      written = cut;
      const r = await readClaudeSession(file, prepare, state);
      state = r.state;
      if (r.read.resumed) resumes++;
      const ref = await referenceRead(file, prepare);
      assert.equal(comparable(r.read), comparable(ref), `differs after ${cut} of ${bytes.length} bytes`);
    }
    assert.equal(resumes, cuts.length - 1, 'every read after the first resumed');
  });
}

test('appends of mixed sizes, including several lines at once, match a full read', async (t) => {
  const dir = mkTmp('ccx-incr-');
  t.after(() => rmrf(dir));
  const file = path.join(dir, 'sess.jsonl');
  const bytes = richLog();
  const prepare = PREPARES['Progress dropped'];
  for (const step of [61, 333, 1024]) {
    fs.writeFileSync(file, '');
    let state;
    for (let cut = 0; cut < bytes.length + step; cut += step) {
      fs.writeFileSync(file, bytes.subarray(0, Math.min(cut, bytes.length)));
      const r = await readClaudeSession(file, prepare, state);
      state = r.state;
      assert.equal(comparable(r.read), comparable(await referenceRead(file, prepare)), `step ${step}, cut ${cut}`);
    }
  }
});

// A state that no longer describes the file must not be resumed from.
for (const [label, mutate] of Object.entries({
  'replaced by a new file': (file, bytes) => { fs.rmSync(file); fs.writeFileSync(file, bytes); },
  'truncated': (file, bytes) => { fs.truncateSync(file, Math.floor(bytes.length / 3)); },
  'rewritten at the start, same size': (file, bytes) => {
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.from('{"type":"user","uuid":"X1"'), 0, 26, 0);
    fs.closeSync(fd);
    void bytes;
  },
  'rewritten just before the resume point': (file) => {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.from('{"type":"zz"}'), 0, 13, size - 14);
    fs.closeSync(fd);
  },
})) {
  test(`a file ${label} is read from the top`, async (t) => {
    const dir = mkTmp('ccx-incr-');
    t.after(() => rmrf(dir));
    const file = path.join(dir, 'sess.jsonl');
    const bytes = richLog();
    const prepare = PREPARES['Progress dropped'];
    fs.writeFileSync(file, bytes);
    const first = await readClaudeSession(file, prepare);
    mutate(file, bytes);
    const r = await readClaudeSession(file, prepare, first.state);
    assert.equal(r.read.resumed, false);
    assert.equal(comparable(r.read), comparable(await referenceRead(file, prepare)));
  });
}

test('an unterminated last line is returned but not committed', async (t) => {
  const dir = mkTmp('ccx-incr-');
  t.after(() => rmrf(dir));
  const file = path.join(dir, 'sess.jsonl');
  const prepare = PREPARES['Progress dropped'];
  const q = JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-05-27T11:00:00.000Z', message: { role: 'user', content: 'Q' } });
  const a = JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-05-27T11:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'A' }] } });
  fs.writeFileSync(file, `${q}\n${a}`);
  const r1 = await readClaudeSession(file, prepare);
  assert.equal(r1.read.main.length, 1);
  assert.ok(r1.read.main[0].finalAssistantEntry, 'the complete-looking last line is used now');
  assert.equal(r1.state.end, Buffer.byteLength(q) + 1, 'but the next read starts at it again');
  fs.appendFileSync(file, '\n');
  const r2 = await readClaudeSession(file, prepare, r1.state);
  assert.equal(r2.read.resumed, true);
  assert.equal(comparable(r2.read), comparable(await referenceRead(file, prepare)));
});

test('only the open end of the conversation is kept as raw entries', async (t) => {
  const dir = mkTmp('ccx-incr-');
  t.after(() => rmrf(dir));
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(file, richLog());
  const { state } = await readClaudeSession(file, PREPARES['Progress dropped']);
  // The last main pair is "last question" / "last answer": two raw entries.
  assert.equal(state.main.open.length, 2);
  assert.equal(state.main.open[0].uuid, 'z1');
  assert.ok(state.main.closed.length > 3);
});
