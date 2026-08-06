import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, mkTmp, rmrf, runCli, writeJsonl, writeCodexSession,
  writeCodexSessionIndex, codexQA, writeConfig,
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

test('out-of-order session-index rows resolve by updated_at, not file order', async (t) => {
  const dir = mkTmp('ccx-session-index-order-');
  t.after(() => rmrf(dir));
  const file = path.join(dir, 'session_index.jsonl');
  writeJsonl(file, [
    { id: 'a', thread_name: 'Newest', updated_at: '2026-08-05T05:30:18Z' },
    { id: 'a', thread_name: 'Older', updated_at: '2026-08-04T00:34:45Z' },
  ]);

  const names = await readSessionIndex(file);
  assert.equal(names.get('a'), 'Newest');
});

test('a session-index rename outranks a stale live-database title', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('node:sqlite unavailable'); return; }
  const home = mkTmp('ccx-session-db-');
  t.after(() => rmrf(home));
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const sessionId = '019f-session-db-0001';
  writeCodexSession(home, 'rollout.jsonl', codexQA(project, { sessionId }));
  // Codex records the explicit rename here before the live database catches
  // up. Its title can still be the automatically generated first message.
  writeCodexSessionIndex(home, [
    { id: sessionId, thread_name: 'Renamed', updated_at: '2026-08-06T03:41:11Z' },
  ]);
  const db = new DatabaseSync(path.join(home, '.codex', 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)');
  db.prepare('INSERT INTO threads (id, name, title) VALUES (?, ?, ?)').run(sessionId, null, '/r');
  db.close();

  const result = runCli([project, '-cx'], { home });
  assert.equal(result.code, 0, result.stderr);
  const output = fs.readFileSync(path.join(project, 'CCXLOG', 'cxlog.md'), 'utf-8');
  assert.ok(output.includes(`[Codex] Session:Renamed:${sessionId}`), output);
  assert.doesNotMatch(output, /Session:\/r:/);
});

test('the live-database title remains a fallback when the index has no name', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('node:sqlite unavailable'); return; }
  const home = mkTmp('ccx-session-db-fallback-');
  t.after(() => rmrf(home));
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const sessionId = '019f-session-db-fallback';
  writeCodexSession(home, 'rollout.jsonl', codexQA(project, { sessionId }));
  const db = new DatabaseSync(path.join(home, '.codex', 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT)');
  db.prepare('INSERT INTO threads (id, name, title) VALUES (?, ?, ?)').run(sessionId, null, 'Database title');
  db.close();

  const result = runCli([project, '-cx'], { home });
  assert.equal(result.code, 0, result.stderr);
  const output = fs.readFileSync(path.join(project, 'CCXLOG', 'cxlog.md'), 'utf-8');
  assert.ok(output.includes(`[Codex] Session:Database title:${sessionId}`), output);
});

test('a nested extra root without its own index falls back to the broader root', (t) => {
  const home = mkTmp('ccx-session-fallthrough-');
  t.after(() => rmrf(home));
  const project = path.join(home, 'project');
  const out = path.join(project, 'CCXLOG');
  fs.mkdirSync(out, { recursive: true });
  const sessionId = '019f-session-fallthrough-1';
  writeCodexSession(home, 'rollout.jsonl', codexQA(project, { sessionId }));
  // Only the standard root's index names this session...
  writeCodexSessionIndex(home, [
    { id: sessionId, thread_name: 'Named', updated_at: '2026-08-05T05:30:18Z' },
  ]);
  // ...while a more specific extra root nested inside it carries no index.
  writeConfig(out, { codex: { extraLogDirs: [path.join(home, '.codex', 'sessions', '2026')] } });

  const result = runCli([project, '-cx'], { home });
  assert.equal(result.code, 0, result.stderr);
  const output = fs.readFileSync(path.join(out, 'cxlog.md'), 'utf-8');
  assert.ok(output.includes(`[Codex] Session:Named:${sessionId}`), output);
});
