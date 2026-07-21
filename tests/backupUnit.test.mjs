// §9.5 backup naming, ported from old-develop unit-backup.test.mjs and adapted
// to new-develop's backupJsonlFiles (which lays out backup_jsonl/<stamp>/<cc|cx>/):
//   CX#7  two files sharing a basename are both preserved (the second is
//         deterministically uniquified, never overwritten).
//   CC#8  an already-existing backup file is never clobbered (exclusive copy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { backupJsonlFiles, BACKUP_JSONL_DIR } from '../dist/lib/backup.js';
import { mkTmp, rmrf } from './helpers.mjs';

const FOLDER = '2026-05-27_10-00-00_test-host';

test('CX#7: two files sharing a basename are both preserved (basename collision uniquified)', async () => {
  const root = mkTmp('ccx-bk-');
  try {
    const a = path.join(root, 'a', 'roll.jsonl');
    const b = path.join(root, 'b', 'roll.jsonl');
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(a, 'AAA');
    fs.writeFileSync(b, 'BBB');
    const out = path.join(root, 'out');
    const copied = await backupJsonlFiles([
      { filePath: a, source: 'claude', baseName: 'roll' },
      { filePath: b, source: 'claude', baseName: 'roll' },
    ], out, FOLDER, false);
    assert.equal(copied, 2);
    const ccDir = path.join(out, BACKUP_JSONL_DIR, FOLDER, 'cc');
    const names = fs.readdirSync(ccDir).sort();
    assert.equal(names.length, 2, 'both files backed up, neither overwritten');
    const contents = new Set(names.map(n => fs.readFileSync(path.join(ccDir, n), 'utf-8')));
    assert.ok(contents.has('AAA') && contents.has('BBB'));
  } finally { rmrf(root); }
});

test('CC#8: an existing backup file is never overwritten (exclusive copy)', async () => {
  const root = mkTmp('ccx-bk-');
  try {
    const src = path.join(root, 'roll.jsonl');
    fs.writeFileSync(src, 'fresh source');
    const out = path.join(root, 'out');
    // Pre-seed the exact destination path with a prior backup.
    const ccDir = path.join(out, BACKUP_JSONL_DIR, FOLDER, 'cc');
    fs.mkdirSync(ccDir, { recursive: true });
    fs.writeFileSync(path.join(ccDir, 'roll.jsonl'), 'PRIOR BACKUP');

    const copied = await backupJsonlFiles([
      { filePath: src, source: 'claude', baseName: 'roll' },
    ], out, FOLDER, false);
    assert.equal(copied, 0, 'nothing copied over an existing backup');
    assert.equal(fs.readFileSync(path.join(ccDir, 'roll.jsonl'), 'utf-8'), 'PRIOR BACKUP',
      'the pre-existing backup content is preserved');
  } finally { rmrf(root); }
});
