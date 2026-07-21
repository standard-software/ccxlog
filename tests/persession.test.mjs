// §2.2 / §8.4 / §9.7 per-session output: prefixes, ownership marker, isolation,
// safe deletion of owned 0-pair files, preservation of unowned ones. Ported
// from old-develop persession.test.mjs, adapted to new-develop wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  run, workspace, writeConfig, writeJsonl, writeRaw, read, exists, claudeQA, codexQA,
} from './helpers.mjs';

// A claude session file that yields zero pairs (an orphan assistant entry).
function claudeOrphan() {
  return [{ type: 'assistant', uuid: 'a', parentUuid: null, timestamp: '2026-05-27T11:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'orphan' }] } }];
}

test('session prefixes are independently configurable', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'sess.jsonl'), claudeQA(ws.project));
  writeJsonl(path.join(ws.cxLogs, 'roll.jsonl'), codexQA(ws.project, { sessionId: 'xid' }));
  writeConfig(ws.out, {
    claude: { extraLogDirs: [ws.ccLogs], outputSessionFilePrefix: 'CC__' },
    codex: { extraLogDirs: [ws.cxLogs], outputSessionFilePrefix: 'CX__' },
  });
  const r = run([ws.project, '--out', ws.out, '--per-session'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(exists(path.join(ws.out, 'CC__sess.md')), true);
  assert.equal(exists(path.join(ws.out, 'CX__xid.md')), true);
});

test('the session file carries a strict ownership marker', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'sess.jsonl'), claudeQA(ws.project));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });
  run([ws.project, '--out', ws.out, '-cc', '--per-session'], { home: ws.home });
  const md = read(path.join(ws.out, 'cclog_sess.md'));
  assert.match(md, /^<!-- ccxlog-owner:ccxlog; kind:session; source:claude; sid64:[A-Za-z0-9_-]+ -->/);
});

test('-cc --per-session never touches an existing cxlog_*.md', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'sess.jsonl'), claudeQA(ws.project));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] }, codex: { extraLogDirs: [ws.cxLogs] } });
  const stray = path.join(ws.out, 'cxlog_other.md');
  writeRaw(stray, 'user owned codex file\n');

  const r = run([ws.project, '--out', ws.out, '-cc', '--per-session'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(exists(path.join(ws.out, 'cclog_sess.md')), true);
  assert.equal(read(stray), 'user owned codex file\n');
});

test('an owned 0-pair session file is deleted after a pre-delete backup (§9.7)', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'sess.jsonl'), claudeQA(ws.project, { q: 'temp', a: 'temp' }));
  writeJsonl(path.join(ws.ccLogs, 'keep.jsonl'), claudeQA(ws.project, { uuid: 'k', q: 'keep', a: 'keep' }));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });

  // First run: creates cclog_sess.md (+ cclog_keep.md).
  assert.equal(run([ws.project, '--out', ws.out, '-cc', '--per-session'], { home: ws.home }).status, 0);
  assert.equal(exists(path.join(ws.out, 'cclog_sess.md')), true);

  // sess now yields zero pairs; keep still has one so the run is not "all zero".
  writeJsonl(path.join(ws.ccLogs, 'sess.jsonl'), claudeOrphan());
  const r = run([ws.project, '--out', ws.out, '-cc', '--per-session'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(exists(path.join(ws.out, 'cclog_sess.md')), false);
  // A pre-delete backup folder was created.
  const backupRoot = path.join(ws.out, 'backup_CCXLOG_md');
  const backups = exists(backupRoot) ? fs.readdirSync(backupRoot) : [];
  assert.ok(backups.length >= 1);
});

test('an unowned same-name session file is preserved, never deleted', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'ghost.jsonl'), claudeOrphan());        // 0 pairs
  writeJsonl(path.join(ws.ccLogs, 'keep.jsonl'), claudeQA(ws.project, { uuid: 'k' }));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });
  const ghost = path.join(ws.out, 'cclog_ghost.md');
  writeRaw(ghost, 'a file a user placed here by hand\n');

  const r = run([ws.project, '--out', ws.out, '-cc', '--per-session'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(ghost), 'a file a user placed here by hand\n');
  assert.match(r.stdout, /\(kept\)/);
});
