// includeSubdirectories (cclog parity): nested-project logs are collected by
// default, excluded when the flag is false, and a same-prefix sibling whose
// real cwd is NOT under the project is never pulled in (confirmed against the
// logged cwd). Covers both sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  run, workspace, writeConfig, writeClaudeSession, writeCodexSession,
  read, claudeQA, codexQA,
} from './helpers.mjs';

// ---- Claude (per-project folders under ~/.claude/projects) -----------------

test('claude: nested-project logs are collected by default (includeSubdirectories true)', t => {
  const ws = workspace(t);
  const sub = path.join(ws.project, 'frontend');
  // Exact project root (folder = encodeCwd(project)).
  writeClaudeSession(ws.home, ws.project, 'base.jsonl', claudeQA(ws.project, { uuid: 'b', q: 'base question' }));
  // Nested project: its cwd is a subdirectory of the project.
  writeClaudeSession(ws.home, sub, 'nested.jsonl', claudeQA(sub, { uuid: 'n', q: 'nested question' }));
  writeConfig(ws.out, {});   // no flag -> default true

  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.match(md, /base question/);
  assert.match(md, /nested question/);
});

test('claude: nested-project logs are excluded when includeSubdirectories is false', t => {
  const ws = workspace(t);
  const sub = path.join(ws.project, 'frontend');
  writeClaudeSession(ws.home, ws.project, 'base.jsonl', claudeQA(ws.project, { uuid: 'b', q: 'base question' }));
  writeClaudeSession(ws.home, sub, 'nested.jsonl', claudeQA(sub, { uuid: 'n', q: 'nested question' }));
  writeConfig(ws.out, { includeSubdirectories: false });

  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.match(md, /base question/);
  assert.doesNotMatch(md, /nested question/);
});

test('claude: a same-prefix sibling (project-backup) is never pulled in even when true', t => {
  const ws = workspace(t);
  // encodeCwd(project + '-backup') starts with encodeCwd(project) + '-', so it
  // matches the discovery prefix — but its real cwd is NOT under the project.
  const sibling = ws.project + '-backup';
  writeClaudeSession(ws.home, ws.project, 'base.jsonl', claudeQA(ws.project, { uuid: 'b', q: 'base question' }));
  writeClaudeSession(ws.home, sibling, 'sib.jsonl', claudeQA(sibling, { uuid: 's', q: 'sibling question' }));
  writeConfig(ws.out, {});   // default true

  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.match(md, /base question/);
  assert.doesNotMatch(md, /sibling question/);
});

// ---- Codex (single shared tree, cwd-filtered) ------------------------------

test('codex: a nested cwd session is collected by default (includeSubdirectories true)', t => {
  const ws = workspace(t);
  const sub = path.join(ws.project, 'frontend');
  writeCodexSession(ws.home, 'base.jsonl', codexQA(ws.project, { sessionId: 'cxbase', q: 'cx base question' }));
  writeCodexSession(ws.home, 'nested.jsonl', codexQA(sub, { sessionId: 'cxnested', q: 'cx nested question' }));
  writeConfig(ws.out, {});

  const r = run([ws.project, '--out', ws.out, '-cx'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cxlog.md'));
  assert.match(md, /cx base question/);
  assert.match(md, /cx nested question/);
});

test('codex: a nested cwd session is excluded when includeSubdirectories is false', t => {
  const ws = workspace(t);
  const sub = path.join(ws.project, 'frontend');
  writeCodexSession(ws.home, 'base.jsonl', codexQA(ws.project, { sessionId: 'cxbase', q: 'cx base question' }));
  writeCodexSession(ws.home, 'nested.jsonl', codexQA(sub, { sessionId: 'cxnested', q: 'cx nested question' }));
  writeConfig(ws.out, { includeSubdirectories: false });

  const r = run([ws.project, '--out', ws.out, '-cx'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cxlog.md'));
  assert.match(md, /cx base question/);
  assert.doesNotMatch(md, /cx nested question/);
});

test('codex: a same-prefix sibling cwd (project-backup) is never pulled in even when true', t => {
  const ws = workspace(t);
  const sibling = ws.project + '-backup';
  writeCodexSession(ws.home, 'base.jsonl', codexQA(ws.project, { sessionId: 'cxbase', q: 'cx base question' }));
  writeCodexSession(ws.home, 'sib.jsonl', codexQA(sibling, { sessionId: 'cxsib', q: 'cx sibling question' }));
  writeConfig(ws.out, {});

  const r = run([ws.project, '--out', ws.out, '-cx'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cxlog.md'));
  assert.match(md, /cx base question/);
  assert.doesNotMatch(md, /cx sibling question/);
});
