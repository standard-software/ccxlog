// §2.1 mode targets: --source aliases, per-mode aggregate renaming, per-source
// %Model%/%Tokens%. Ported from old-develop mode.test.mjs, adapted to the new
// develop CLI (extraLogDirs-pinned discovery, cc5 message wording).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  run, workspace, writeConfig, writeJsonl, read, exists, claudeQA, codexQA,
} from './helpers.mjs';

// One Claude + one Codex session, both attributed to the project, discovered
// via explicit extraLogDirs so no real logs are needed.
function setup(t, extraConfig = {}) {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'claude-a.jsonl'),
    claudeQA(ws.project, { ts: '2026-05-27T11:03:49.000Z', q: 'CC question', a: 'CC answer' }));
  writeJsonl(path.join(ws.cxLogs, 'rollout-x.jsonl'),
    codexQA(ws.project, { ts: '2026-05-27T10:00:00.000Z', q: 'CX question', a: 'CX answer' }));
  writeConfig(ws.out, {
    claude: { extraLogDirs: [ws.ccLogs] },
    codex: { extraLogDirs: [ws.cxLogs] },
    ...extraConfig,
  });
  return ws;
}

test('--source claude is equivalent to -cc', t => {
  const ws = setup(t);
  const r = run([ws.project, '--out', ws.out, '--source', 'claude'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(exists(path.join(ws.out, 'cclog.md')), true);
  assert.equal(exists(path.join(ws.out, 'ccxlog.md')), false);
});

test('--source codex is equivalent to -cx', t => {
  const ws = setup(t);
  const r = run([ws.project, '--out', ws.out, '--source', 'codex'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(exists(path.join(ws.out, 'cxlog.md')), true);
  assert.equal(exists(path.join(ws.out, 'ccxlog.md')), false);
});

test('outputAllFileName renames only the both-mode aggregate', t => {
  const ws = setup(t, { outputAllFileName: 'merged.md' });
  const r = run([ws.project, '--out', ws.out], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(exists(path.join(ws.out, 'merged.md')), true);
  assert.equal(exists(path.join(ws.out, 'ccxlog.md')), false);
  assert.match(r.stdout, /Mode: aggregate \(merged\.md\)/);
});

test('claude.outputAllFileName / codex.outputAllFileName rename only their own mode', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'), claudeQA(ws.project, { q: 'CC question' }));
  writeJsonl(path.join(ws.cxLogs, 'r.jsonl'), codexQA(ws.project, { q: 'CX question' }));
  writeConfig(ws.out, {
    claude: { extraLogDirs: [ws.ccLogs], outputAllFileName: 'cc-custom.md' },
    codex: { extraLogDirs: [ws.cxLogs], outputAllFileName: 'cx-custom.md' },
  });
  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);
  assert.equal(run([ws.project, '--out', ws.out, '-cx'], { home: ws.home }).status, 0);
  assert.equal(exists(path.join(ws.out, 'cc-custom.md')), true);
  assert.equal(exists(path.join(ws.out, 'cx-custom.md')), true);
  assert.equal(exists(path.join(ws.out, 'cclog.md')), false);
  assert.equal(exists(path.join(ws.out, 'cxlog.md')), false);
});

test('%Model% and %Tokens% render per source (§6.4/§7.2)', t => {
  const ws = setup(t);
  assert.equal(run([ws.project, '--out', ws.out], { home: ws.home }).status, 0);
  const md = read(path.join(ws.out, 'ccxlog.md'));
  assert.match(md, /Model=claude-opus-4-8/);
  assert.match(md, /Model=gpt-5/);
  // Claude reports cache write (undefined reasoning); Codex reports reasoning
  // (undefined cache write). Comma grouping is locale-independent.
  assert.match(md, /in 6, out 33, cache read 21,758, cache write 0/);   // claude
  assert.match(md, /in 10, out 20, cache read 0, reasoning 5/);         // codex
});
