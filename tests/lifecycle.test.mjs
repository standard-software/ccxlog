// §8.1 smart-write lifecycle: noop -> append -> rewrite
// (every rewrite is backed up), config gates. Ported from
// old-develop output.test.mjs, adapted to new-develop wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  run, workspace, writeConfig, writeJsonl, writeRaw, read, exists, claudeQA,
} from './helpers.mjs';

function ccOnly(t, files, extra = {}) {
  const ws = workspace(t);
  for (const [name, events] of files) writeJsonl(path.join(ws.ccLogs, name), events);
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] }, ...extra });
  return ws;
}

test('second identical run is a noop and preserves mtime; a later pair appends', t => {
  const ws = ccOnly(t, []);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'),
    claudeQA(ws.project, { uuid: 'a', ts: '2026-05-27T10:00:00.000Z', q: 'first' }));
  const file = path.join(ws.out, 'cclog.md');

  assert.match(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).stdout, /\[create\]/);
  const m1 = fs.statSync(file).mtimeMs;

  const second = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.match(second.stdout, /\[noop\]/);
  assert.equal(fs.statSync(file).mtimeMs, m1);

  writeJsonl(path.join(ws.ccLogs, 'b.jsonl'),
    claudeQA(ws.project, { uuid: 'b', ts: '2026-05-27T11:00:00.000Z', q: 'second' }));
  const third = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.match(third.stdout, /\[append\]/);
  const md = read(file);
  assert.ok(md.indexOf('first') < md.indexOf('second'));
});

test('inserting an earlier pair rewrites and backs up first', t => {
  const ws = ccOnly(t, []);
  writeJsonl(path.join(ws.ccLogs, 'b.jsonl'),
    claudeQA(ws.project, { uuid: 'b', ts: '2026-05-27T11:00:00.000Z', q: 'later' }));
  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);

  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'),
    claudeQA(ws.project, { uuid: 'a', ts: '2026-05-27T10:00:00.000Z', q: 'earlier' }));
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.match(r.stdout, /\[rewrite\]/);
  assert.match(r.stdout, /Backed up 1 pre-overwrite md file/);
  assert.equal(exists(path.join(ws.out, 'backup_CCXLOG_md')), true);
});

test('deleting a source log triggers a rewrite backed up first', t => {
  const ws = ccOnly(t, []);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'),
    claudeQA(ws.project, { uuid: 'a', ts: '2026-05-27T10:00:00.000Z', q: 'keep' }));
  writeJsonl(path.join(ws.ccLogs, 'b.jsonl'),
    claudeQA(ws.project, { uuid: 'b', ts: '2026-05-27T11:00:00.000Z', q: 'doomed' }));
  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);

  fs.rmSync(path.join(ws.ccLogs, 'b.jsonl'));
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.match(r.stdout, /\[rewrite\]/);
  assert.match(r.stdout, /Backed up 1 pre-overwrite md file/);
  assert.equal(exists(path.join(ws.out, 'backup_CCXLOG_md')), true);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.match(md, /keep/);
  assert.doesNotMatch(md, /doomed/);
});

test('changing only the template rewrites and backs up first', t => {
  const ws = ccOnly(t, []);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'), claudeQA(ws.project, { uuid: 'a', q: 'stable' }));
  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);

  // A custom template with the same %CcxlogId% marker so identities still match.
  writeRaw(path.join(ws.out, 'templates', 'alt.md'),
    '<!-- %CcxlogId% -->\n# %DateTime% [%Source%]\nQ: %Question%\nA: %Answer%\n\n----------------------------------------\n\n');
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] }, template: 'templates/alt.md' });
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.match(r.stdout, /\[rewrite\]/);
  assert.match(r.stdout, /Backed up 1 pre-overwrite md file/);
  assert.equal(exists(path.join(ws.out, 'backup_CCXLOG_md')), true);
});

test('invalid config JSON is rejected (exit 1) and no default-named file is written', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'), claudeQA(ws.project));
  writeRaw(path.join(ws.out, 'ccxlog.config.json'), '{ broken json');
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(exists(path.join(ws.out, 'cclog.md')), false);
});
