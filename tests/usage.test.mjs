// §2.1 / §3.2 CLI argument parsing and usage errors. Ported from old-develop
// cli.test.mjs. The pure combinations are asserted directly against parseArgs
// (kind: 'help' | 'version' | 'error' | 'ok'); index.ts maps 'error' -> exit 2,
// 'help'/'version' -> exit 0. --help / --version are ALSO exercised end to end
// through the compiled binary to confirm the printed output and exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../dist/lib/cli.js';
import { runCli } from './helpers.mjs';

// parseArgs consumes process.argv, i.e. it slices off the first two entries.
const parse = (...args) => parseArgs(['node', 'ccxlog', ...args]);

test('--help / -h parse to a help request and the binary prints usage (exit 0)', () => {
  assert.equal(parse('--help').kind, 'help');
  assert.equal(parse('-h').kind, 'help');
  const r = runCli(['--help']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /outputAllFileName\s+merged output \(default: ccxlog\.md\)/);
  assert.match(r.stdout, /claude\.outputAllFileName\s+-cc output\s+\(default: cclog\.md\)/);
  assert.match(r.stdout, /codex\.outputAllFileName\s+-cx output\s+\(default: cxlog\.md\)/);
  assert.match(r.stdout, /<out>\/ccxlog\.config\.json/);
});

test('--version / -v / -V print a version string and exit 0', () => {
  for (const flag of ['--version', '-v', '-V']) {
    assert.equal(parse(flag).kind, 'version', flag);
  }
  const r = runCli(['--version']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('-cc agreeing with --source claude is allowed (redundant, not a usage error)', () => {
  const r = parse('some/project', '-cc', '--source', 'claude');
  assert.equal(r.kind, 'ok');
  assert.equal(r.opts.mode, 'claude');
});

test('-cc and -cx together is a usage error (not last-wins)', () => {
  assert.equal(parse('p', '-cc', '-cx').kind, 'error');
});

test('-cc conflicting with --source codex is a usage error', () => {
  assert.equal(parse('p', '-cc', '--source', 'codex').kind, 'error');
});

test('--source with an invalid value is a usage error', () => {
  const r = parse('p', '--source', 'gemini');
  assert.equal(r.kind, 'error');
  assert.match(r.msg, /Invalid --source value/);
});

test('single-char / bundled short flags are unknown options', () => {
  for (const bad of ['-c', '-x', '-ccx']) {
    assert.equal(parse('p', bad).kind, 'error', bad);
  }
});

test('--out with a missing value (followed by a flag) is a usage error', () => {
  assert.equal(parse('p', '--out', '--dry-run').kind, 'error');
  assert.equal(parse('p', '--out').kind, 'error');
});

test('a second positional argument is a usage error', () => {
  const r = parse('first', 'second');
  assert.equal(r.kind, 'error');
  assert.match(r.msg, /positional/);
});

test('an unknown long option is a usage error', () => {
  assert.equal(parse('p', '--bogus').kind, 'error');
});

test('standalone actions are mutually exclusive and reject --per-session', () => {
  // Two standalone actions together.
  assert.equal(parse('p', '--init-template', '--backup-jsonl').kind, 'error');
  assert.equal(parse('p', '--init-template', '--backup-md').kind, 'error');
  assert.equal(parse('p', '--backup-jsonl', '--backup-md').kind, 'error');
  // A standalone action combined with --per-session.
  assert.equal(parse('p', '--per-session', '--init-template').kind, 'error');
  assert.equal(parse('p', '--per-session', '--backup-jsonl').kind, 'error');
  assert.equal(parse('p', '--per-session', '--backup-md').kind, 'error');
});
