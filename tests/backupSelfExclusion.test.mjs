import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  run, workspace, writeConfig, writeJsonl, read, claudeQA,
} from './helpers.mjs';

function scaffold(t) {
  const ws = workspace(t);
  const live = path.join(ws.root, 'cc-live');
  writeJsonl(path.join(live, 'live.jsonl'), claudeQA(ws.project, { uuid: 'u-live', q: 'LIVE-QUESTION' }));
  const oldSnap = path.join(ws.out, 'backup_jsonl', '2026-01-01_00-00-00_OLDPC', 'cc');
  writeJsonl(path.join(oldSnap, 'expired.jsonl'),
    claudeQA(ws.project, { uuid: 'u-old', q: 'OLD-BACKUP-QUESTION', ts: '2026-05-01T09:00:00.000Z' }));
  writeConfig(ws.out, { claude: { extraLogDirs: [live, oldSnap] } });
  return { ws, live, oldSnap };
}

test('readback: an old snapshot under <out>/backup_jsonl is rendered into the output', t => {
  const { ws } = scaffold(t);
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.match(md, /LIVE-QUESTION/);
  assert.match(md, /OLD-BACKUP-QUESTION/);
});

test('--backup-jsonl never re-copies files already under its own destination', t => {
  const { ws } = scaffold(t);
  const r = run([ws.project, '--out', ws.out, '--backup-jsonl'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const snaps = fs.readdirSync(path.join(ws.out, 'backup_jsonl')).filter(d => d !== '2026-01-01_00-00-00_OLDPC');
  assert.equal(snaps.length, 1, `expected one new snapshot, got: ${snaps.join(', ')}`);
  const newSnapCc = path.join(ws.out, 'backup_jsonl', snaps[0], 'cc');
  const copied = fs.readdirSync(newSnapCc);
  assert.ok(copied.some(f => f.startsWith('live')), `live log must be backed up: ${copied.join(', ')}`);
  assert.ok(!copied.some(f => f.startsWith('expired')), `old backup must NOT be re-copied: ${copied.join(', ')}`);
  assert.ok(fs.existsSync(path.join(ws.out, 'backup_jsonl', '2026-01-01_00-00-00_OLDPC', 'cc', 'expired.jsonl')));
});
