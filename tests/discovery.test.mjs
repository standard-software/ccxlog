// §5.3 discovery robustness: excluded dirs, standard roots, reorder invariance,
// symlink follow. Ported from old-develop discovery.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  run, workspace, writeConfig, writeJsonl, read, encodeCwd, claudeQA, codexQA,
} from './helpers.mjs';

test('recursion is source-defined and legacy config values are ignored', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'direct.jsonl'),
    claudeQA(ws.project, { uuid: 'cc-direct', q: 'claude direct' }));
  writeJsonl(path.join(ws.ccLogs, 'nested', 'ignored.jsonl'),
    claudeQA(ws.project, { uuid: 'cc-nested', q: 'claude nested' }));
  writeJsonl(path.join(ws.cxLogs, '2026', '07', '23', 'rollout.jsonl'),
    codexQA(ws.project, { sessionId: 'cx-nested', q: 'codex nested' }));
  writeConfig(ws.out, {
    claude: { extraLogDirs: [ws.ccLogs], recursive: true },
    codex: { extraLogDirs: [ws.cxLogs], recursive: false },
  });

  const r = run([ws.project, '--out', ws.out], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /claude\.recursive.*no longer supported/i);
  assert.match(r.stderr, /codex\.recursive.*no longer supported/i);
  const md = read(path.join(ws.out, 'ccxlog.md'));
  assert.match(md, /claude direct/);
  assert.doesNotMatch(md, /claude nested/);
  assert.match(md, /codex nested/);
});

test('templates/ and backup_* subdirectories are never ingested', t => {
  const ws = workspace(t);
  const logs = path.join(ws.root, 'logs');
  writeJsonl(path.join(logs, 'keep', 'real.jsonl'), codexQA(ws.project, { sessionId: 'k', q: 'real question' }));
  writeJsonl(path.join(logs, 'templates', 'decoy.jsonl'), codexQA(ws.project, { sessionId: 'd1', q: 'template decoy' }));
  writeJsonl(path.join(logs, 'backup_jsonl', 'decoy.jsonl'), codexQA(ws.project, { sessionId: 'd2', q: 'backup decoy' }));
  writeConfig(ws.out, { codex: { extraLogDirs: [logs] } });

  const r = run([ws.project, '--out', ws.out, '-cx'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cxlog.md'));
  assert.match(md, /real question/);
  assert.doesNotMatch(md, /template decoy/);
  assert.doesNotMatch(md, /backup decoy/);
});

test('the generated <out> is excluded from discovery (never re-ingested)', t => {
  const ws = workspace(t);
  // A decoy jsonl placed under <out> must not be discovered even if a root
  // encloses it.
  writeJsonl(path.join(ws.out, 'sneaky.jsonl'), codexQA(ws.project, { sessionId: 's', q: 'sneaky decoy' }));
  writeJsonl(path.join(ws.project, 'realdir', 'a.jsonl'), codexQA(ws.project, { sessionId: 'r', q: 'legit question' }));
  writeConfig(ws.out, { codex: { extraLogDirs: [ws.project] } });

  const r = run([ws.project, '--out', ws.out, '-cx'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cxlog.md'));
  assert.match(md, /legit question/);
  assert.doesNotMatch(md, /sneaky decoy/);
});

test('reordering extraLogDirs does not change the output byte-for-byte (§5.5)', t => {
  const ws = workspace(t);
  const dirA = path.join(ws.root, 'A');
  const dirB = path.join(ws.root, 'B');
  writeJsonl(path.join(dirA, 'a.jsonl'),
    codexQA(ws.project, { sessionId: 'sa', ts: '2026-05-27T10:00:00.000Z', q: 'from A' }));
  writeJsonl(path.join(dirB, 'b.jsonl'),
    codexQA(ws.project, { sessionId: 'sb', ts: '2026-05-27T11:00:00.000Z', q: 'from B' }));

  writeConfig(ws.out, { codex: { extraLogDirs: [dirA, dirB] } });
  assert.equal(run([ws.project, '--out', ws.out, '-cx'], { home: ws.home }).status, 0);
  const forward = read(path.join(ws.out, 'cxlog.md'));

  writeConfig(ws.out, { codex: { extraLogDirs: [dirB, dirA] } });
  assert.equal(run([ws.project, '--out', ws.out, '-cx'], { home: ws.home }).status, 0);
  const reversed = read(path.join(ws.out, 'cxlog.md'));

  assert.equal(forward, reversed);
});

test('claude standard root is discovered via HOME encoding', t => {
  const ws = workspace(t);
  const dir = path.join(ws.home, '.claude', 'projects', encodeCwd(ws.project));
  writeJsonl(path.join(dir, 'sess.jsonl'), claudeQA(ws.project, { uuid: 'std', q: 'standard root q' }));
  writeConfig(ws.out, {});

  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(path.join(ws.out, 'cclog.md')), /standard root q/);
});

test('a symlinked log directory is followed during discovery', t => {
  const ws = workspace(t);
  const realDir = path.join(ws.root, 'real-logs');
  writeJsonl(path.join(realDir, 'sess.jsonl'), claudeQA(ws.project, { uuid: 'sym', q: 'behind a symlink' }));
  const linkDir = path.join(ws.root, 'linked-logs');
  try {
    fs.symlinkSync(realDir, linkDir, 'dir');
  } catch (e) {
    t.skip(`symlinks not permitted on this host: ${e.code}`);
    return;
  }
  writeConfig(ws.out, { claude: { extraLogDirs: [linkDir] } });
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(path.join(ws.out, 'cclog.md')), /behind a symlink/);
});

test('per-session real filename collision (both prefixes equal) is a write-time error', t => {
  const ws = workspace(t);
  // Same session id on both sources + identical prefixes => same target file.
  writeJsonl(path.join(ws.ccLogs, 'dup.jsonl'), claudeQA(ws.project, { uuid: 'c' }));
  writeJsonl(path.join(ws.cxLogs, 'dup.jsonl'), codexQA(ws.project, { sessionId: 'dup' }));
  writeConfig(ws.out, {
    claude: { extraLogDirs: [ws.ccLogs], outputSessionFilePrefix: 'log_' },
    codex: { extraLogDirs: [ws.cxLogs], outputSessionFilePrefix: 'log_' },
  });
  const r = run([ws.project, '--out', ws.out, '--per-session'], { home: ws.home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /collision/);
});
