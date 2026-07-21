// §9.4 --backup-md, §9.5 --backup-jsonl, §7.4 --init-template.
// Ported from old-develop backups.test.mjs, adapted to new-develop wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  run, workspace, writeConfig, writeJsonl, writeRaw, read, exists, claudeQA, codexQA,
} from './helpers.mjs';

function onlyStamp(dir) {
  const names = fs.readdirSync(dir);
  assert.equal(names.length, 1, `expected one stamp dir in ${dir}`);
  return path.join(dir, names[0]);
}

test('--backup-jsonl copies logs unaltered into per-source subdirectories', t => {
  const ws = workspace(t);
  const ccFile = path.join(ws.ccLogs, 'claude-a.jsonl');
  const cxFile = path.join(ws.cxLogs, 'roll.jsonl');
  writeJsonl(ccFile, claudeQA(ws.project));
  writeJsonl(cxFile, codexQA(ws.project));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] }, codex: { extraLogDirs: [ws.cxLogs] } });

  const r = run([ws.project, '--out', ws.out, '--backup-jsonl'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Backed up 2 jsonl file/);

  const stamp = onlyStamp(path.join(ws.out, 'backup_jsonl'));
  assert.equal(read(path.join(stamp, 'cc', 'claude-a.jsonl')), read(ccFile));  // byte-for-byte
  assert.equal(read(path.join(stamp, 'cx', 'roll.jsonl')), read(cxFile));
});

test('--backup-jsonl for a single source only backs up that source', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'), claudeQA(ws.project));
  writeJsonl(path.join(ws.cxLogs, 'roll.jsonl'), codexQA(ws.project));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] }, codex: { extraLogDirs: [ws.cxLogs] } });

  const r = run([ws.project, '--out', ws.out, '-cc', '--backup-jsonl'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const stamp = onlyStamp(path.join(ws.out, 'backup_jsonl'));
  assert.equal(exists(path.join(stamp, 'cc')), true);
  assert.equal(exists(path.join(stamp, 'cx')), false);
});

test('--backup-md backs up owned aggregates but not unrelated .md', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'), claudeQA(ws.project));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });
  // Generate a real, owned cclog.md first.
  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);
  // A user-authored, unowned markdown must be ignored.
  writeRaw(path.join(ws.out, 'notes.md'), '# just my notes\n');

  const r = run([ws.project, '--out', ws.out, '--backup-md'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Backed up 1 md file/);
  const stamp = onlyStamp(path.join(ws.out, 'backup_CCXLOG_md'));
  assert.equal(exists(path.join(stamp, 'cclog.md')), true);
  assert.equal(exists(path.join(stamp, 'notes.md')), false);
});

test('--init-template copies the template and rewrites config to the local copy', t => {
  const ws = workspace(t);
  const r = run([ws.project, '--out', ws.out, '--init-template'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(exists(path.join(ws.out, 'templates', 'english.md')), true);
  const cfg = JSON.parse(read(path.join(ws.out, 'ccxlog.config.json')));
  assert.equal(cfg.template, 'templates/english.md');
});

test('--init-template refuses to overwrite an existing local template (exit 1)', t => {
  const ws = workspace(t);
  assert.equal(run([ws.project, '--out', ws.out, '--init-template'], { home: ws.home }).status, 0);
  const again = run([ws.project, '--out', ws.out, '--init-template'], { home: ws.home });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
});

test('after --init-template the local copy wins over the bundled default', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'), claudeQA(ws.project, { q: 'q', a: 'a' }));
  assert.equal(run([ws.project, '--out', ws.out, '--init-template'], { home: ws.home }).status, 0);
  // Edit the local copy with a distinctive marker, keeping %PairId%.
  writeRaw(path.join(ws.out, 'templates', 'english.md'),
    '<!-- ccxlog-pair:%PairId% -->\nLOCAL-COPY [%Source%] %Question%\n\n----------------------------------------\n\n');
  // Re-point discovery (init-template wrote a minimal config).
  const cfg = JSON.parse(read(path.join(ws.out, 'ccxlog.config.json')));
  cfg.claude = { ...(cfg.claude || {}), extraLogDirs: [ws.ccLogs] };
  writeRaw(path.join(ws.out, 'ccxlog.config.json'), JSON.stringify(cfg));

  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);
  assert.match(read(path.join(ws.out, 'cclog.md')), /LOCAL-COPY/);
});

test('--dry-run --init-template creates nothing', t => {
  const ws = workspace(t);
  const r = run([ws.project, '--out', ws.out, '--init-template', '--dry-run'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(dry run\) would copy/);
  assert.equal(exists(path.join(ws.out, 'templates')), false);
});
