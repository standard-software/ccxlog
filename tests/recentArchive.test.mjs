import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  workspace, writeConfig, writeClaudeSession, claudeQA, runCli, read, exists,
} from './helpers.mjs';
import { archiveFileName, recentCutoffMs } from '../dist/lib/recentArchive.js';

const NOW = '2026-08-19T12:00:00';
const runAtNow = (args, ws) => runCli(args, { home: ws.home, cwd: ws.project, env: { CCXLOG_TEST_NOW: NOW } });

function config(ws, recentDays) {
  writeConfig(ws.out, { recentDays, claude: { extraLogDirs: [ws.ccLogs] } });
}

test('recentDays supports 15 local dates and archive naming preserves the extension', () => {
  assert.equal(recentCutoffMs(8, new Date(NOW)), new Date(2026, 7, 12).getTime());
  assert.equal(recentCutoffMs(15, new Date(NOW)), new Date(2026, 7, 5).getTime());
  assert.equal(archiveFileName('ccxlog.md'), 'ccxlog_archive.md');
  assert.equal(archiveFileName('custom.log'), 'custom_archive.log');
  assert.equal(archiveFileName('custom'), 'custom_archive');
});

test('15 days keeps the same weekday two weeks ago and archives the day before it', t => {
  const ws = workspace(t);
  config(ws, 15);
  writeClaudeSession(ws.home, ws.project, 'recent.jsonl', claudeQA(ws.project, {
    q: 'same weekday', ts: '2026-08-05T01:00:00.000Z', uuid: 'recent',
  }));
  writeClaudeSession(ws.home, ws.project, 'old.jsonl', claudeQA(ws.project, {
    q: 'one day older', ts: '2026-08-04T01:00:00.000Z', uuid: 'old',
  }));
  const r = runAtNow(['--out', ws.out, '-cc'], ws);
  assert.equal(r.code, 0, r.stderr);
  assert.match(read(path.join(ws.out, 'cclog.md')), /same weekday/);
  assert.doesNotMatch(read(path.join(ws.out, 'cclog.md')), /one day older/);
  assert.match(read(path.join(ws.out, 'cclog_archive.md')), /one day older/);
});

test('splitting a v1.8-style single aggregate does not trigger backup; a large window removes an empty archive', t => {
  const ws = workspace(t);
  writeClaudeSession(ws.home, ws.project, 'recent.jsonl', claudeQA(ws.project, {
    q: 'recent', ts: '2026-08-19T01:00:00.000Z', uuid: 'recent',
  }));
  writeClaudeSession(ws.home, ws.project, 'old.jsonl', claudeQA(ws.project, {
    q: 'old', ts: '2026-07-01T01:00:00.000Z', uuid: 'old',
  }));

  config(ws, 1000);
  assert.equal(runAtNow(['--out', ws.out, '-cc'], ws).code, 0);
  assert.equal(exists(path.join(ws.out, 'cclog_archive.md')), false);

  config(ws, 15);
  assert.equal(runAtNow(['--out', ws.out, '-cc'], ws).code, 0);
  assert.equal(exists(path.join(ws.out, 'cclog_archive.md')), true);
  assert.equal(exists(path.join(ws.out, 'backup_CCXLOG_md_auto')), false);

  config(ws, 1000);
  assert.equal(runAtNow(['--out', ws.out, '-cc'], ws).code, 0);
  assert.equal(exists(path.join(ws.out, 'cclog_archive.md')), false);
  assert.match(read(path.join(ws.out, 'cclog.md')), /recent/);
  assert.match(read(path.join(ws.out, 'cclog.md')), /old/);
  assert.equal(exists(path.join(ws.out, 'backup_CCXLOG_md_auto')), false);
});

test('real loss from the two-file union backs up both old files together', t => {
  const ws = workspace(t);
  config(ws, 15);
  const recentLog = path.join(ws.ccLogs, 'recent.jsonl');
  const oldLog = path.join(ws.ccLogs, 'old.jsonl');
  fs.mkdirSync(ws.ccLogs, { recursive: true });
  fs.writeFileSync(recentLog, claudeQA(ws.project, {
    q: 'recent', ts: '2026-08-19T01:00:00.000Z', uuid: 'recent',
  }).map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(oldLog, claudeQA(ws.project, {
    q: 'old', ts: '2026-07-01T01:00:00.000Z', uuid: 'old',
  }).map(JSON.stringify).join('\n') + '\n');
  assert.equal(runAtNow(['--out', ws.out, '-cc'], ws).code, 0);

  fs.rmSync(oldLog);
  assert.equal(runAtNow(['--out', ws.out, '-cc'], ws).code, 0);
  const root = path.join(ws.out, 'backup_CCXLOG_md_auto');
  const folders = fs.readdirSync(root);
  assert.equal(folders.length, 1);
  const backup = path.join(root, folders[0]);
  assert.equal(exists(path.join(backup, 'cclog.md')), true);
  assert.equal(exists(path.join(backup, 'cclog_archive.md')), true);
});
