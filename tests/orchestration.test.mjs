// Orchestration guards ported from old-develop orchestration.test.mjs, adapted
// to new-develop behavior:
//   CX#2  a per-session duplicate (an older snapshot that is a strict forward
//         prefix of a longer one) collapses onto the LONGEST snapshot without
//         losing the pair unique to the newer snapshot. In new-develop the
//         collapse happens in the discovery+dedupe path of AGGREGATE mode (the
//         --per-session mode treats two same-id snapshots as a filename
//         collision instead — covered by discovery.test.mjs), so the guard is
//         asserted where the collapse actually runs.
//   CC#10 --dry-run must still refuse an unowned same-name aggregate file and
//         leave it untouched (new-develop reports the refusal on stderr and
//         exits 1 rather than printing a "would ERROR" line to stdout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  run, workspace, writeConfig, writeJsonl, writeRaw, read, claudeQA,
} from './helpers.mjs';

test('CX#2: an older snapshot that is a strict prefix collapses onto the longest (no lost pairs)', t => {
  const ws = workspace(t);
  const dirA = path.join(ws.root, 'logs-a');
  const dirB = path.join(ws.root, 'logs-b');

  // Identical first pair (byte-for-byte) so dirA is a strict forward prefix
  // (older snapshot) of dirB. Same file basename => same session id.
  const p1 = claudeQA(ws.project, { q: 'question one', a: 'a1', ts: '2026-05-27T10:00:00.000Z', uuid: 'p1' });
  const p2 = claudeQA(ws.project, { q: 'question two', a: 'a2', ts: '2026-05-27T11:00:00.000Z', uuid: 'p2' });
  writeJsonl(path.join(dirA, 'sess.jsonl'), p1);              // older: 1 pair
  writeJsonl(path.join(dirB, 'sess.jsonl'), [...p1, ...p2]);  // newer: 2 pairs

  writeConfig(ws.out, { claude: { extraLogDirs: [dirA, dirB] } });
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.match(md, /question one/, 'the shared first pair is present');
  assert.match(md, /question two/, 'the pair unique to the newer snapshot must NOT be dropped');
  // The shared first pair is emitted once (the older snapshot is deduped away).
  assert.equal((md.match(/<!-- ccxlogid:[0-9a-f]{24} -->/g) || []).length, 2, 'exactly two pairs after the collapse');
  assert.match(r.stdout, /De-duplicated 1 logical duplicate pair/);
});

test('CC#10: --dry-run refuses an unowned same-name aggregate and leaves it untouched (exit 1)', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'), claudeQA(ws.project));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });
  // A hand-written, unowned file at the aggregate output path.
  writeRaw(path.join(ws.out, 'cclog.md'), 'my own notes, not generated\n');

  const r = run([ws.project, '--out', ws.out, '-cc', '--dry-run'], { home: ws.home });
  assert.equal(r.status, 1, 'dry-run still reports the fatal ownership problem');
  assert.match(r.stderr, /ownership-unconfirmed|Refusing to overwrite/, 'the refusal is surfaced, not silently ignored');
  // The unowned file is untouched.
  assert.equal(read(path.join(ws.out, 'cclog.md')), 'my own notes, not generated\n');
});
