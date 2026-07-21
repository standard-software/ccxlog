// §10 edge cases: one/both sources absent, empty & malformed logs, cwd
// attribution, extraCwds, cumulative-token accounting. Ported from old-develop
// edge.test.mjs, adapted to new-develop discovery + wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  run, workspace, writeConfig, writeJsonl, writeRaw, read, exists, claudeQA, codexQA,
} from './helpers.mjs';

test('mode both succeeds from one source when the other has no logs', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'), claudeQA(ws.project, { q: 'solo claude' }));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });
  const r = run([ws.project, '--out', ws.out], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'ccxlog.md'));
  assert.match(md, /solo claude/);
  assert.match(md, /\[ClaudeCode\]/);
  assert.doesNotMatch(md, /^Source=ClaudeCode/m);
  assert.doesNotMatch(md, /Source=Codex/);
});

test('all sources empty leaves existing output unchanged and exits 1', t => {
  const ws = workspace(t);
  fs.mkdirSync(ws.ccLogs, { recursive: true });
  fs.mkdirSync(ws.cxLogs, { recursive: true });
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] }, codex: { extraLogDirs: [ws.cxLogs] } });
  const r = run([ws.project, '--out', ws.out, '--verbose'], { home: ws.home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No pairs found/);
  assert.equal(exists(path.join(ws.out, 'ccxlog.md')), false);
});

test('an empty jsonl file is skipped without failing the run', t => {
  const ws = workspace(t);
  writeRaw(path.join(ws.ccLogs, 'empty.jsonl'), '');
  writeJsonl(path.join(ws.ccLogs, 'real.jsonl'), claudeQA(ws.project, { uuid: 'r', q: 'real one' }));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(path.join(ws.out, 'cclog.md')), /real one/);
});

test('malformed JSON lines are skipped, counted, and reported per session', t => {
  const ws = workspace(t);
  const good = claudeQA(ws.project, { uuid: 'g', q: 'valid q', a: 'valid a' });
  const lines = good.map(e => JSON.stringify(e));
  lines.splice(1, 0, '{ this is not json');   // one broken line in the middle
  writeRaw(path.join(ws.ccLogs, 'mixed.jsonl'), lines.join('\n') + '\n');
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });

  const r = run([ws.project, '--out', ws.out, '-cc', '--per-session'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[1 unparseable lines\]/);
  assert.match(read(path.join(ws.out, 'cclog_mixed.md')), /valid q/);
});

test('codex pairs are attributed by cwd from the shared standard root', t => {
  const ws = workspace(t);
  const sessions = path.join(ws.home, '.codex', 'sessions', '2026', '05', '27');
  writeJsonl(path.join(sessions, 'mine.jsonl'),
    codexQA(ws.project, { sessionId: 'mine', q: 'my project q' }));
  writeJsonl(path.join(sessions, 'other.jsonl'),
    codexQA('C:/some/other/place', { sessionId: 'other', q: 'foreign q' }));
  writeConfig(ws.out, {}); // rely on the standard ~/.codex root

  const r = run([ws.project, '--out', ws.out, '-cx'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cxlog.md'));
  assert.match(md, /my project q/);
  assert.doesNotMatch(md, /foreign q/);
});

test('extraCwds pull in codex sessions from another project directory', t => {
  const ws = workspace(t);
  const alternate = path.join(ws.root, 'alternate');
  fs.mkdirSync(alternate, { recursive: true });
  const sessions = path.join(ws.home, '.codex', 'sessions', '2026', '05', '27');
  writeJsonl(path.join(sessions, 'alt.jsonl'),
    codexQA(alternate, { sessionId: 'alt', q: 'alt project q' }));
  writeConfig(ws.out, { extraCwds: [alternate] });

  const r = run([ws.project, '--out', ws.out, '-cx'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(path.join(ws.out, 'cxlog.md')), /alt project q/);
});

test('codex tokens are not double-counted across re-emitted cumulative reports', t => {
  const ws = workspace(t);
  // Two token_count events with a cumulative counter: 10 then 25 => delta 10 + 15.
  const ts = '2026-05-27T10:00:00.000Z';
  const events = [
    { timestamp: ts, type: 'session_meta', payload: { session_id: 'tok', cwd: ws.project, cli_version: '1', git: { branch: 'main' } } },
    { timestamp: ts, type: 'turn_context', payload: { turn_id: 't1', cwd: ws.project, model: 'm' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: 'q' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'agent_message', message: 'a' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 0 } } } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 25, output_tokens: 0 } } } },
  ];
  writeJsonl(path.join(ws.cxLogs, 'roll.jsonl'), events);
  writeConfig(ws.out, { codex: { extraLogDirs: [ws.cxLogs] } });
  assert.equal(run([ws.project, '--out', ws.out, '-cx'], { home: ws.home }).status, 0);
  // 10 (first) + 15 (delta) = 25 input tokens, not 35.
  assert.match(read(path.join(ws.out, 'cxlog.md')), /Tokens=in 25/);
});
