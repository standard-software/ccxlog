import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, mkTmp, rmrf, runCli, writeJsonl, writeCodexSession,
  writeCodexSessionIndex, codexQA,
} from './helpers.mjs';

function pathToUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, '/')}`).href;
}

const { readSessionIndex } = await import(
  pathToUrl(path.join(ROOT, 'dist', 'sources', 'codex', 'sessionIndex.js'))
);

test('Codex thread_name from session_index.jsonl is rendered as SessionName', (t) => {
  const home = mkTmp('ccx-session-name-');
  t.after(() => rmrf(home));
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const sessionId = '019f-session-name-0001';
  writeCodexSession(home, 'rollout.jsonl', codexQA(project, { sessionId }));
  writeCodexSessionIndex(home, [
    { id: sessionId, thread_name: 'Codex1', updated_at: '2026-08-03T02:32:48Z' },
  ]);

  const result = runCli([project, '-cx'], { home });
  assert.equal(result.code, 0, result.stderr);
  const output = fs.readFileSync(path.join(project, 'CCXLOG', 'cxlog.md'), 'utf-8');
  assert.match(output, new RegExp(`\\[Codex\\] Session:Codex1:${sessionId}`));
});

test('the latest valid session-index row wins and an empty rename clears it', async (t) => {
  const dir = mkTmp('ccx-session-index-');
  t.after(() => rmrf(dir));
  const file = path.join(dir, 'session_index.jsonl');
  writeJsonl(file, [
    { id: 'a', thread_name: 'First' },
    '{ malformed',
    { id: 'ignored-without-name' },
    { id: 'a', thread_name: 'Latest' },
    { id: 'b', thread_name: 'Temporary' },
    { id: 'b', thread_name: '   ' },
  ]);

  const names = await readSessionIndex(file);
  assert.equal(names.get('a'), 'Latest');
  assert.equal(names.has('b'), false);
  assert.equal(names.has('ignored-without-name'), false);
});

test('a co-located session index names Codex sessions from extraLogDirs', (t) => {
  const root = mkTmp('ccx-extra-session-name-');
  t.after(() => rmrf(root));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const out = path.join(project, 'CCXLOG');
  const logs = path.join(root, 'copied-codex');
  const sessionId = '019f-session-name-extra';
  fs.mkdirSync(project, { recursive: true });
  writeJsonl(path.join(logs, '2026', '08', '03', 'rollout.jsonl'),
    codexQA(project, { sessionId }));
  writeJsonl(path.join(logs, 'session_index.jsonl'), [
    { id: sessionId, thread_name: 'Container Codex' },
  ]);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'ccxlog.config.json'), JSON.stringify({
    codex: { extraLogDirs: [logs] },
  }), 'utf-8');

  const result = runCli([project, '--out', out, '-cx'], { home });
  assert.equal(result.code, 0, result.stderr);
  const output = fs.readFileSync(path.join(out, 'cxlog.md'), 'utf-8');
  assert.match(output, new RegExp(`Session:Container Codex:${sessionId}`));
});

test('an embedded session_meta title remains a fallback when no index exists', (t) => {
  const home = mkTmp('ccx-embedded-session-name-');
  t.after(() => rmrf(home));
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const records = codexQA(project, { sessionId: 'embedded-name' });
  records[0].payload.title = 'Embedded title';
  writeCodexSession(home, 'rollout.jsonl', records);

  const result = runCli([project, '-cx'], { home });
  assert.equal(result.code, 0, result.stderr);
  const output = fs.readFileSync(path.join(project, 'CCXLOG', 'cxlog.md'), 'utf-8');
  assert.match(output, /Session:Embedded title:embedded-name/);
});
