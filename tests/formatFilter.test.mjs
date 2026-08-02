import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  run, workspace, writeConfig, writeJsonl, read, exists, claudeQA, codexQA,
} from './helpers.mjs';

function mixedDir(ws) {
  const logs = path.join(ws.root, 'mixed');
  writeJsonl(path.join(logs, 'claude-session.jsonl'), claudeQA(ws.project, { uuid: 'c1', q: 'claude-only question' }));
  writeJsonl(path.join(logs, 'codex-rollout.jsonl'), codexQA(ws.project, { sessionId: 'x1', q: 'codex-only question' }));
  writeJsonl(path.join(logs, 'junk.jsonl'), [
    { kind: 'metrics', value: 42 },
    { kind: 'metrics', value: 43 },
  ]);
  return logs;
}

test('claude ingests only claude-format files from a mixed dir (codex/junk skipped)', t => {
  const ws = workspace(t);
  const logs = mixedDir(ws);
  writeConfig(ws.out, { claude: { extraLogDirs: [logs] } });
  const r = run([ws.project, '--out', ws.out, '-cc', '--verbose'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.match(md, /claude-only question/);
  assert.doesNotMatch(md, /codex-only question/);
  assert.match(r.stdout, /format-skipped: 2/);
  assert.match(r.stdout, /skipped \(not claude-format\).*codex-rollout\.jsonl/);
  assert.match(r.stdout, /skipped \(not claude-format\).*junk\.jsonl/);
});

test('codex ingests only codex-format files from a mixed dir (claude/junk skipped)', t => {
  const ws = workspace(t);
  const logs = mixedDir(ws);
  writeConfig(ws.out, { codex: { extraLogDirs: [logs] } });
  const r = run([ws.project, '--out', ws.out, '-cx', '--verbose'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cxlog.md'));
  assert.match(md, /codex-only question/);
  assert.doesNotMatch(md, /claude-only question/);
  assert.match(r.stdout, /format-skipped: 2/);
  assert.match(r.stdout, /skipped \(not codex-format\).*claude-session\.jsonl/);
  assert.match(r.stdout, /skipped \(not codex-format\).*junk\.jsonl/);
});

test('the same mixed dir can be listed in both sources; each takes its own format', t => {
  const ws = workspace(t);
  const logs = mixedDir(ws);
  writeConfig(ws.out, {
    claude: { extraLogDirs: [logs] },
    codex: { extraLogDirs: [logs] },
  });
  const r = run([ws.project, '--out', ws.out], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'ccxlog.md'));
  assert.match(md, /claude-only question/);
  assert.match(md, /codex-only question/);
  assert.equal((md.match(/claude-only question/g) ?? []).length, 1);
  assert.equal((md.match(/codex-only question/g) ?? []).length, 1);
});

test('--backup-jsonl copies only the selected source format from a mixed dir', t => {
  const ws = workspace(t);
  const logs = mixedDir(ws);
  writeConfig(ws.out, {
    claude: { extraLogDirs: [logs] },
    codex: { extraLogDirs: [logs] },
  });

  const cc = run([ws.project, '--out', ws.out, '-cc', '--backup-jsonl'], { home: ws.home });
  assert.equal(cc.status, 0, cc.stderr);
  const ccStamp = fs.readdirSync(path.join(ws.out, 'backup_jsonl'))[0];
  const ccRoot = path.join(ws.out, 'backup_jsonl', ccStamp);
  assert.equal(exists(path.join(ccRoot, 'cc', 'claude-session.jsonl')), true);
  assert.equal(exists(path.join(ccRoot, 'cc', 'codex-rollout.jsonl')), false);
  assert.equal(exists(path.join(ccRoot, 'cc', 'junk.jsonl')), false);

  fs.rmSync(path.join(ws.out, 'backup_jsonl'), { recursive: true, force: true });
  const cx = run([ws.project, '--out', ws.out, '-cx', '--backup-jsonl'], { home: ws.home });
  assert.equal(cx.status, 0, cx.stderr);
  const cxStamp = fs.readdirSync(path.join(ws.out, 'backup_jsonl'))[0];
  const cxRoot = path.join(ws.out, 'backup_jsonl', cxStamp);
  assert.equal(exists(path.join(cxRoot, 'cx', 'codex-rollout.jsonl')), true);
  assert.equal(exists(path.join(cxRoot, 'cx', 'claude-session.jsonl')), false);
  assert.equal(exists(path.join(cxRoot, 'cx', 'junk.jsonl')), false);
});
