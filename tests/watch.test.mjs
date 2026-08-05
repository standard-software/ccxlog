import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ROOT, CLI, mkTmp, rmrf, runCli, writeJsonl, writeClaudeSession, writeCodexSession,
  writeCodexSessionIndex, claudeQA, codexQA, countPairs,
} from './helpers.mjs';

const {
  classifyWatchToken, parseWatchDuration, validateIntervalSeconds,
  MAX_DURATION_SECONDS,
} = await import(pathToUrl(path.join(ROOT, 'dist', 'lib', 'watchArgs.js')));
const { parseArgs } = await import(pathToUrl(path.join(ROOT, 'dist', 'lib', 'cli.js')));
const { createWatchLoop, emptyWriteCounts, formatSummary } =
  await import(pathToUrl(path.join(ROOT, 'dist', 'lib', 'watchRunner.js')));
const { createWarningReporter } = await import(pathToUrl(path.join(ROOT, 'dist', 'lib', 'watchWarnings.js')));
const { createAnalysisCache, cacheKey } =
  await import(pathToUrl(path.join(ROOT, 'dist', 'lib', 'analysisCache.js')));
const { canonicalPath } = await import(pathToUrl(path.join(ROOT, 'dist', 'lib', 'pathUtils.js')));

function pathToUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, '/')}`).href;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function scaffold(t, { claude = true, codex = false, interval = 1 } = {}) {
  const home = mkTmp('ccx-watch-');
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const out = path.join(project, 'CCXLOG');
  if (claude) writeClaudeSession(home, project, 'sess1.jsonl', claudeQA(project));
  if (codex) writeCodexSession(home, 'rollout-2026-05-27T11-04-49-019f-codex-0001.jsonl', codexQA(project));
  if (interval !== null) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'ccxlog.config.json'),
      JSON.stringify({ watchIntervalSeconds: interval }), 'utf-8');
  }
  if (t) t.after(() => { killLiveWatches(); rmrf(home); });
  return { home, project, out };
}

const liveWatches = new Set();

function killLiveWatches() {
  for (const c of liveWatches) c.kill('SIGKILL');
  liveWatches.clear();
}

function childEnv(home) {
  return { ...process.env, HOME: home, USERPROFILE: home, HOMEDRIVE: '', HOMEPATH: '' };
}

function startWatch(args, home, cwd = ROOT, extraEnv = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...childEnv(home), ...extraEnv }, cwd });
  liveWatches.add(child);
  const state = { stdout: '', stderr: '', code: null, signal: null };
  child.stdout.on('data', d => { state.stdout += d; });
  child.stderr.on('data', d => { state.stderr += d; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => {
    liveWatches.delete(child);
    state.code = code; state.signal = signal; resolve(state);
  }));
  return { child, state, exited };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 30000, step = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(step);
  }
}

async function waitStarted(w) {
  return await waitFor(() => /^ccxlog watch started \(pid \d+\)/m.test(w.state.stdout));
}

async function waitChangedCycle(w, re = /pair\(s\) \[/) {
  return await waitFor(() => re.test(w.state.stdout));
}

async function forceStop(w) {
  w.child.kill('SIGKILL');
  return await w.exited;
}

// ---------------------------------------------------------------------------
// A. Syntax and arguments (§3)
// ---------------------------------------------------------------------------

test('A-1: accepted --watch forms map to the documented durations', () => {
  assert.deepEqual(classifyWatchToken('--watch'), { kind: 'watch', durationSeconds: null });
  assert.deepEqual(classifyWatchToken('--watch=60s'), { kind: 'watch', durationSeconds: 60 });
  assert.deepEqual(classifyWatchToken('--watch=2m'), { kind: 'watch', durationSeconds: 120 });
  assert.deepEqual(classifyWatchToken('--watch=1h'), { kind: 'watch', durationSeconds: 3600 });
  assert.deepEqual(classifyWatchToken('--watch=1d'), { kind: 'watch', durationSeconds: 86400 });
  assert.deepEqual(classifyWatchToken('--watch=366d'), { kind: 'watch', durationSeconds: MAX_DURATION_SECONDS });
  assert.equal(classifyWatchToken('-cc'), null);
  assert.equal(classifyWatchToken('--verbose'), null);
});

test('A-2 [regression]: --watch=60 (no unit) is a usage error with no side effects', (t) => {
  const s = scaffold(t);
  const r = runCli([s.project, '--watch=60'], { home: s.home });
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stderr, /unit is required \(s\/m\/h\/d\)/);
  assert.equal(fs.existsSync(path.join(s.out, 'ccxlog.md')), false);
  assert.equal(fs.existsSync(path.join(s.out, '.ccxlog.lock')), false);
  assert.equal(fs.existsSync(path.join(s.out, 'backup_CCXLOG_md_auto')), false);
});

test('A-3: E2/E4/E5/E6/E7/E8/E9/E10 are usage errors that name the cause', (t) => {
  const s = scaffold(t);
  const cases = [
    [['--watch=0s'], /positive integer/],                 // E2
    [['--watch=00m'], /positive integer/],                // E2
    [['--watch=060s'], /leading zeros are not allowed/],  // E4
    [['--watch=1.5m'], /Invalid --watch syntax: "--watch=1\.5m": expected --watch or --watch=<n><s\|m\|h\|d>/],
    [['--watch=+60s'], /Invalid --watch syntax/],          // E5
    [['--watch=60S'], /Invalid --watch syntax/],           // E5
    [['--watch=s'], /Invalid --watch syntax/],             // E5
    [['--watch= 60s'], /Invalid --watch syntax/],          // E5
    [['--watch=1h30m'], /single positive integer/],
    [['--watch', '60s'], /Duration must use equals with --watch/],   // E7
    [['--watch='], /Invalid --watch syntax/],              // E7
    [['--watch[60s]'], /Invalid --watch syntax/],
    [['--watch[]'], /Invalid --watch syntax/],
    [['--watch', '--watch=60s'], /Only one of --watch/],   // E8
    [['--watch', '--watch'], /Only one of --watch/],
    [['--watch=367d'], /must be between 1s and 366d/],     // E9
    [['--watch=99999999999s'], /must be between 1s and 366d/],       // E9
    [['--watchfoo'], /Invalid --watch syntax/],            // E10
  ];
  for (const [args, re] of cases) {
    const r = runCli([s.project, ...args], { home: s.home });
    assert.equal(r.code, 2, `${args.join(' ')} -> ${r.code}\n${r.stdout}`);
    assert.match(r.stderr, re, args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(s.out, 'ccxlog.md')), false);
});

test('A-3b: parseWatchDuration rejects overflow before converting', () => {
  assert.deepEqual(parseWatchDuration('31622400s'), { seconds: MAX_DURATION_SECONDS });
  assert.ok('error' in parseWatchDuration('31622401s'));
  assert.ok('error' in parseWatchDuration('99999999999999999999d'));
  assert.match(parseWatchDuration('60').error, /a unit is required/);
  assert.match(parseWatchDuration('0s').error, /positive integer/);
  assert.match(parseWatchDuration('060s').error, /leading zeros/);
  assert.match(parseWatchDuration('1h30m').error, /single positive integer/);
  assert.deepEqual(parseWatchDuration('1.5m'), { syntax: true });
});

test('A-4: forbidden combinations are code 2; allowed ones parse; a usage error suppresses -h', () => {
  const bad = [
    ['--watch', '--force-unlock'],
    ['--watch', '--init-template'],
    ['--watch', '--backup-jsonl'],
    ['--watch', '--backup-md'],
  ];
  for (const args of bad) {
    const r = parseArgs(['node', 'ccxlog', ...args]);
    assert.equal(r.kind, 'error', args.join(' '));
  }
  const good = [
    ['--watch', '-cc'],
    ['--watch', '-cx'],
    ['--watch=10s', '--per-session'],
    ['--watch', '--verbose'],
    ['--watch', '--dry-run'],
    ['--watch', '--lock'],
    ['--watch', '--out', 'x'],
  ];
  for (const args of good) {
    const r = parseArgs(['node', 'ccxlog', ...args]);
    assert.equal(r.kind, 'ok', `${args.join(' ')} -> ${r.kind}: ${r.msg ?? ''}`);
  }
  assert.equal(parseArgs(['node', 'ccxlog', '--watch=60', '-h']).kind, 'error');
  assert.equal(parseArgs(['node', 'ccxlog', '--watch', '--force-unlock', '-h']).kind, 'error');
  assert.equal(parseArgs(['node', 'ccxlog', '--watch=60', '-v']).kind, 'error');
});

test('A-5: the help text documents --watch and the interval key, and nothing else watch-related', () => {
  const r = runCli(['-h']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /--watch\s+Run repeatedly/);
  assert.match(r.stdout, /--watch=<n><unit>/);
  assert.match(r.stdout, /watchIntervalSeconds/);
  assert.doesNotMatch(r.stdout, /--watch-clear/);
});

// ---------------------------------------------------------------------------
// B. Loop and timing (§5) — fake clock (not a millisecond of real time is waited)
// ---------------------------------------------------------------------------

function fakeLoop({ durationSeconds, cycleMs, intervalSeconds, maxCycles = Infinity }) {
  let clock = 0;
  const starts = [];
  const waits = [];
  let handle = null;
  const loop = createWatchLoop({
    durationSeconds,
    verbose: false,
    out: { log() {}, warn() {}, error() {} },
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
    cycle: async () => {
      starts.push(clock);
      clock += cycleMs;
      if (starts.length >= maxCycles) handle.requestStop('sigint');
      return {
        ok: true, pairs: 1, writes: emptyWriteCounts(), changed: false,
        writeLabel: 'noop', intervalSeconds,
      };
    },
  });
  handle = loop;
  return { loop, starts, waits };
}

test('B-5: fixed WAIT, not a fixed period: T=3s, W=5s -> cycle starts at 0, 8, 16s', async () => {
  const f = fakeLoop({ durationSeconds: null, cycleMs: 3000, intervalSeconds: 5, maxCycles: 3 });
  await f.loop.run();
  assert.deepEqual(f.starts, [0, 8000, 16000]);
});

test('B-6: --watch=60s, W=5, T=1s -> 10 cycles at 0..54s, no 11th, no trailing wait', async () => {
  const f = fakeLoop({ durationSeconds: 60, cycleMs: 1000, intervalSeconds: 5 });
  const summary = await f.loop.run();
  assert.deepEqual(f.starts, [0, 6000, 12000, 18000, 24000, 30000, 36000, 42000, 48000, 54000]);
  assert.equal(summary.cycles, 10);
  assert.equal(summary.reason, 'duration');
  assert.equal(summary.exitCode, 0);
  assert.equal(f.waits.at(-1), 5000);
});

test('B-7 (E11): --watch=1s with a 4s cycle still runs exactly one full cycle', async () => {
  const f = fakeLoop({ durationSeconds: 1, cycleMs: 4000, intervalSeconds: 5 });
  const summary = await f.loop.run();
  assert.deepEqual(f.starts, [0]);
  assert.equal(summary.cycles, 1);
  assert.equal(summary.exitCode, 0);
  assert.equal(f.waits.length, 0);
});

test('B-12/E14: processing longer than the wait never overlaps or catches up', async () => {
  const f = fakeLoop({ durationSeconds: null, cycleMs: 8000, intervalSeconds: 5, maxCycles: 3 });
  await f.loop.run();
  assert.deepEqual(f.starts, [0, 13000, 26000]);
});

test('B-9 (E16): a suspend past the deadline during the wait adds no extra cycle', async () => {
  let clock = 0;
  const starts = [];
  const loop = createWatchLoop({
    durationSeconds: 60,
    verbose: false,
    out: { log() {}, warn() {}, error() {} },
    now: () => clock,
    sleep: async (ms) => { clock += ms + 120000; },
    cycle: async () => {
      starts.push(clock);
      clock += 1000;
      return { ok: true, pairs: 0, writes: emptyWriteCounts(), changed: false, writeLabel: 'noop', intervalSeconds: 5 };
    },
  });
  const summary = await loop.run();
  assert.deepEqual(starts, [0]);
  assert.equal(summary.reason, 'duration');
});

test('B-13 (§5.5): Ctrl+C during a cycle stops after it completes, with code 130', async () => {
  let clock = 0;
  const starts = [];
  let loop = null;
  loop = createWatchLoop({
    durationSeconds: null,
    verbose: false,
    out: { log() {}, warn() {}, error() {} },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    cycle: async () => {
      starts.push(clock);
      assert.equal(loop.isProcessing(), true);
      if (starts.length === 2) loop.requestStop('sigint');
      clock += 1000;
      return { ok: true, pairs: 0, writes: emptyWriteCounts(), changed: false, writeLabel: 'noop', intervalSeconds: 5 };
    },
  });
  const summary = await loop.run();
  assert.deepEqual(starts, [0, 6000]);
  assert.equal(summary.cycles, 2);
  assert.equal(summary.reason, 'sigint');
  assert.equal(summary.exitCode, 130);
  assert.equal(loop.isProcessing(), false);
  assert.match(formatSummary(summary)[0], /^ccxlog watch stopped \(interrupted \(Ctrl\+C\)\): 2 cycle\(s\)/);
});

test('B-summary: the exit summary aggregates what actually happened (F-44)', async () => {
  let clock = 0;
  let n = 0;
  const lines = [];
  const loop = createWatchLoop({
    durationSeconds: 20,
    verbose: false,
    out: { log: m => lines.push(m), warn() {}, error: m => lines.push(m) },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    cycle: async () => {
      n++;
      clock += 1000;
      const writes = emptyWriteCounts();
      if (n === 1) { writes.create = 1; return ok(writes, 'create', true, '3 pair(s) [create]'); }
      if (n === 2) {
        return { ok: false, failure: 'boom', pairs: 0, writes, changed: false, writeLabel: 'none', intervalSeconds: 5 };
      }
      writes.noop = 1;
      return ok(writes, 'noop', false);
    },
  });
  function ok(writes, label, changed, line) {
    return { ok: true, pairs: 3, writes, changed, changeLine: line, writeLabel: label, intervalSeconds: 5 };
  }
  const s = await loop.run();
  assert.equal(s.cycles, 4);
  assert.equal(s.failed, 1);
  assert.equal(s.changed, 1);
  assert.equal(s.writes.create, 1);
  assert.equal(s.writes.noop, 2);
  assert.equal(s.exitCode, 0);
  assert.match(lines.join('\n'), /cycle failed: boom/);
  assert.match(lines.join('\n'), /recovered: cycle succeeded after 1 failed cycle\(s\)/);
  assert.equal(lines.filter(l => /pair\(s\) \[create\]/.test(l)).length, 1);
  assert.equal(lines.filter(l => /noop/.test(l)).length, 0);
});

test('F-45b (§10.1): an exception crossing the cycle boundary propagates instead of being swallowed', async () => {
  let clock = 0;
  let cycles = 0;
  const loop = createWatchLoop({
    durationSeconds: null,
    verbose: false,
    out: { log() {}, warn() {}, error() {} },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    cycle: async () => {
      cycles++;
      throw new Error('control layer broke');
    },
  });
  await assert.rejects(() => loop.run(), /control layer broke/);
  assert.equal(cycles, 1);
  assert.equal(loop.isProcessing(), false, 'an exception must not leave the loop marked as processing');
});

test('F-40: identical failures are suppressed but re-summarised every 60s', async () => {
  let clock = 0;
  const errs = [];
  let n = 0;
  const loop = createWatchLoop({
    durationSeconds: 300,
    verbose: false,
    out: { log() {}, warn() {}, error: m => errs.push(m) },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    cycle: async () => {
      n++;
      clock += 100;
      return { ok: false, failure: 'Lock error: held', pairs: 0, writes: emptyWriteCounts(), changed: false, writeLabel: 'none', intervalSeconds: 5 };
    },
  });
  await loop.run();
  assert.ok(n > 50, `expected many cycles, got ${n}`);
  assert.equal(errs.filter(l => /cycle failed: Lock error: held/.test(l)).length, 1);
  const agg = errs.filter(l => /previous error repeated \d+ times in the last 60s/.test(l));
  assert.ok(agg.length >= 4, `expected periodic aggregates, got ${agg.length}`);
});

test('F-40b: the aggregate line claims "in the last 60s" only when it IS the 60s re-display', async () => {
  let clock = 0;
  const errs = [];
  const logs = [];
  let n = 0;
  const loop = createWatchLoop({
    durationSeconds: 30,
    verbose: false,
    out: { log: m => logs.push(m), warn() {}, error: m => errs.push(m) },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    cycle: async () => {
      n++;
      clock += 100;
      const base = { pairs: 0, writes: emptyWriteCounts(), changed: false, intervalSeconds: 5 };
      if (n <= 3) return { ...base, ok: false, failure: 'Lock error: held', writeLabel: 'none' };
      return { ...base, ok: true, writeLabel: 'noop' };
    },
  });
  await loop.run();
  assert.equal(errs.filter(l => /cycle failed: Lock error: held/.test(l)).length, 1);
  const flushes = errs.filter(l => /previous error repeated/.test(l));
  assert.equal(flushes.length, 1, errs.join('\n'));
  assert.match(flushes[0], /\(previous error repeated 2 more time\(s\)\)$/);
  assert.doesNotMatch(flushes[0], /in the last 60s/);
  assert.match(logs.join('\n'), /recovered: cycle succeeded after 3 failed cycle\(s\)/);
});

// ---------------------------------------------------------------------------
// C. Configuration (§4)
// ---------------------------------------------------------------------------

test('C-11/12: watchIntervalSeconds validation warns and falls back to 5', () => {
  assert.deepEqual(validateIntervalSeconds(undefined), { seconds: 5 });
  assert.deepEqual(validateIntervalSeconds(10), { seconds: 10 });
  assert.deepEqual(validateIntervalSeconds(1), { seconds: 1 });
  assert.deepEqual(validateIntervalSeconds(86400), { seconds: 86400 });
  for (const bad of [0, -1, 2.5, '10', 100000, null, true, NaN, Infinity]) {
    const r = validateIntervalSeconds(bad);
    assert.equal(r.seconds, 5, String(bad));
    assert.match(r.warning, /watchIntervalSeconds must be an integer between 1 and 86400; using default \(5\)\./);
  }
});

test('C-12b: an invalid interval warns once and still starts the watch (exit 0)', async (t) => {
  const s = scaffold(t, { interval: null });
  fs.mkdirSync(s.out, { recursive: true });
  fs.writeFileSync(path.join(s.out, 'ccxlog.config.json'),
    JSON.stringify({ watchIntervalSeconds: 0 }), 'utf-8');
  const w = startWatch([s.project, '--watch=2s'], s.home);
  const st = await w.exited;
  assert.equal(st.code, 0, st.stderr);
  assert.match(st.stderr, /watchIntervalSeconds must be an integer between 1 and 86400/);
  assert.match(st.stdout, /ccxlog watch started \(pid \d+\): interval 5s/);
});

test('C-15: a plain run with watchIntervalSeconds set neither warns nor fails', (t) => {
  const s = scaffold(t, { interval: 10 });
  const r = runCli([s.project], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /watchIntervalSeconds/);
  assert.doesNotMatch(r.stderr, /unknown top-level config key/);
});

test('C-16 (§9.3): warning suppression is driven by the monotonic clock, not by the wall clock', () => {
  const warns = [];
  let mono = 0;
  let wall = new Date(2026, 6, 31, 12, 0, 0);
  const reporter = createWarningReporter(
    { log() {}, warn: m => warns.push(m), error() {} },
    () => mono,
    () => wall,
  );
  const W = ['Warning: watchIntervalSeconds must be an integer between 1 and 86400; using default (5).'];

  reporter.report(W);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^\[2026\/07\/31 12:00:00\] Warning: watchIntervalSeconds/);

  wall = new Date(2026, 6, 31, 13, 0, 0);
  reporter.report(W);
  wall = new Date(2026, 6, 31, 11, 0, 0);
  reporter.report(W);
  mono = 59_999;
  reporter.report(W);
  assert.equal(warns.length, 1, `wall-clock changes must not redisplay warnings:\n${warns.join('\n')}`);

  mono = 60_000;
  reporter.report(W);
  assert.equal(warns.length, 2);
  assert.match(warns[1], /^\[2026\/07\/31 11:00:00\] Warning: watchIntervalSeconds/);

  reporter.report(['Warning: another one']);
  assert.equal(warns.length, 3);
  reporter.report([]);
  reporter.report(['Warning: another one']);
  assert.equal(warns.length, 4, 'a warning after a clear period must not be suppressed');

  const primed = [];
  const r2 = createWarningReporter(
    { log() {}, warn: m => primed.push(m), error() {} }, () => mono, () => wall);
  r2.prime(W);
  wall = new Date(2026, 6, 31, 20, 0, 0);
  r2.report(W);
  assert.deepEqual(primed, [], 'startup warnings must not repeat in the first cycle');
  mono += 60_000;
  r2.report(W);
  assert.equal(primed.length, 1, 'the warning reappears after 60 monotonic seconds');
});

test('C-11b (§9.2): the start banner reports pid, interval, duration and the two ways to stop', async (t) => {
  const s = scaffold(t, { interval: 2 });
  const w = startWatch([s.project, '--watch=3s'], s.home);
  const st = await w.exited;
  assert.equal(st.code, 0, st.stderr);
  assert.match(st.stdout, /ccxlog watch started \(pid \d+\): interval 2s, duration 3s, mode both/);
  assert.match(st.stdout, /^ {2}project: .+proj/m);
  assert.match(st.stdout, /^ {2}output: {2}.+ccxlog\.md$/m);
  const hint = st.stdout.split('\n').filter(l => /^Press Ctrl\+C to stop/.test(l));
  assert.equal(hint.length, 1, st.stdout);
  assert.match(hint[0], new RegExp(`terminate pid \\d+ from another terminal \\(e\\.g\\. ${
    process.platform === 'win32' ? 'taskkill /F /PID \\d+' : 'kill \\d+'}\\)\\.$`));
  assert.doesNotMatch(st.stdout, /--watch-clear/);
});

test('C-11c: bare --watch reports an unlimited duration in the banner', async (t) => {
  const s = scaffold(t, { interval: 1 });
  const w = startWatch([s.project, '--watch'], s.home);
  assert.ok(await waitStarted(w), w.state.stderr);
  assert.match(w.state.stdout, /duration unlimited, mode both/);
  await forceStop(w);
});

test('C-13/C-14 (E18/E19): interval changes take effect next cycle; a broken config fails cycles and recovers', async (t) => {
  const s = scaffold(t, { interval: 1 });
  const cfg = path.join(s.out, 'ccxlog.config.json');
  const w = startWatch([s.project, '--watch'], s.home);
  assert.ok(await waitChangedCycle(w), w.state.stdout + w.state.stderr);
  fs.writeFileSync(cfg, '{ this is not json', 'utf-8');
  assert.ok(await waitFor(() => /cycle failed: Config error/.test(w.state.stderr), 15000),
    w.state.stdout + w.state.stderr);
  assert.equal(fs.existsSync(path.join(s.out, 'ccxlog.md')), true);
  fs.writeFileSync(cfg, JSON.stringify({ watchIntervalSeconds: 2 }), 'utf-8');
  assert.ok(await waitFor(() => /recovered: cycle succeeded/.test(w.state.stdout), 15000),
    w.state.stdout + w.state.stderr);
  assert.match(w.state.stdout, /recovered: cycle succeeded after \d+ failed cycle\(s\)/);
  await forceStop(w);
});

test('C-14b (§4.3): a cycle whose config turned fatal waits the default 5s, not the configured value', async (t) => {
  const s = scaffold(t, { interval: 1 });
  const cfg = path.join(s.out, 'ccxlog.config.json');
  const w = startWatch([s.project, '--watch', '--verbose'], s.home);
  assert.ok(await waitStarted(w), w.state.stderr);
  fs.writeFileSync(`${cfg}.new`,
    JSON.stringify({ watchIntervalSeconds: 10, template: 'no-such-template.md' }), 'utf-8');
  fs.renameSync(`${cfg}.new`, cfg);
  assert.ok(await waitFor(() => /template "no-such-template\.md" not found/.test(w.state.stderr), 15000),
    w.state.stdout + w.state.stderr);
  assert.ok(await waitFor(() => /next wait 5\.0s/.test(w.state.stdout), 15000),
    `a fatal-error cycle must wait the default 5 seconds:\n${w.state.stdout}`);
  assert.doesNotMatch(w.state.stdout, /next wait 10\.0s/,
    'the invalid configured value of 10 seconds must not be used');
  await forceStop(w);
});

// ---------------------------------------------------------------------------
// E. Relationship with existing features (§8)
// ---------------------------------------------------------------------------

test('E-8/B-8: a watch cycle produces byte-identical output to a single run', async (t) => {
  for (const extra of [[], ['-cc'], ['-cx'], ['--per-session']]) {
    const label = extra.join(' ') || 'both';
    const s = scaffold(t, { codex: true });
    const w = startWatch([s.project, '--watch', ...extra], s.home);
    assert.ok(await waitChangedCycle(w),
      `watch wrote nothing for ${label}\n--- stdout ---\n${w.state.stdout}\n--- stderr ---\n${w.state.stderr}`);
    await forceStop(w);
    const names = fs.readdirSync(s.out).filter(f => f.endsWith('.md')).sort();
    const snapshot = names.map(f => [f, fs.readFileSync(path.join(s.out, f))]);
    assert.ok(names.length > 0, label);

    for (const [name] of snapshot) fs.rmSync(path.join(s.out, name));
    const r = runCli([s.project, ...extra], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(s.out).filter(f => f.endsWith('.md')).sort(), names, label);
    for (const [name, buf] of snapshot) {
      assert.deepEqual(fs.readFileSync(path.join(s.out, name)), buf, `${name} (${label})`);
    }
  }
});

test('E-32: -cc --watch only touches cclog.md', async (t) => {
  const s = scaffold(t, { codex: true });
  for (const m of [[], ['-cc'], ['-cx']]) assert.equal(runCli([s.project, ...m], { home: s.home }).code, 0);
  const before = ['ccxlog.md', 'cxlog.md'].map(f => fs.statSync(path.join(s.out, f)).mtimeMs);
  fs.rmSync(path.join(s.out, 'cclog.md'));
  const w = startWatch([s.project, '-cc', '--watch'], s.home);
  assert.ok(await waitChangedCycle(w), w.state.stdout + w.state.stderr);
  await forceStop(w);
  assert.equal(fs.existsSync(path.join(s.out, 'cclog.md')), true);
  const after = ['ccxlog.md', 'cxlog.md'].map(f => fs.statSync(path.join(s.out, f)).mtimeMs);
  assert.deepEqual(after, before, 'other aggregates must not be touched (mtime included)');
});

test('E-36 (E40): --dry-run --watch runs its cycles and writes nothing at all', async (t) => {
  const s = scaffold(t, { interval: 1 });
  const w = startWatch([s.project, '--watch=3s', '--dry-run'], s.home);
  const st = await w.exited;
  assert.equal(st.code, 0, st.stderr);
  assert.match(st.stdout, /ccxlog watch started \(pid \d+\).*\(dry run\)/);
  assert.match(st.stdout, /ccxlog watch stopped \(duration elapsed\): [1-9]\d* cycle\(s\)/);
  assert.equal(fs.existsSync(path.join(s.out, 'ccxlog.md')), false);
  assert.equal(fs.existsSync(path.join(s.out, '.ccxlog.lock')), false);
  assert.equal(fs.existsSync(path.join(s.out, 'backup_CCXLOG_md_auto')), false);
});

test('E-35b: watch locks automatically for its full lifetime and releases on stop', async (t) => {
  const s = scaffold(t);
  const w = startWatch([s.project, '--watch=3s'], s.home);
  assert.ok(await waitStarted(w), w.state.stderr);
  assert.equal(fs.existsSync(path.join(s.out, '.ccxlog.lock')), true,
    'the lock remains held while watch is waiting between cycles');
  const st = await w.exited;
  assert.equal(st.code, 0, st.stderr);
  assert.equal(fs.existsSync(path.join(s.out, '.ccxlog.lock')), false,
    'normal watch completion releases the lifetime lock');
});

test('E-34: a running watch blocks another watch and a plain ccxlog until it stops', async (t) => {
  const s = scaffold(t, { interval: 1 });
  const first = startWatch([s.project, '--watch=4s'], s.home);
  assert.ok(await waitStarted(first), first.state.stderr);

  const oneShot = runCli([s.project], { home: s.home });
  assert.equal(oneShot.code, 1, oneShot.stderr + oneShot.stdout);
  assert.match(oneShot.stderr, /Lock error: Another ccxlog run holds the lock/);

  const second = startWatch([s.project, '--watch=2s'], s.home);
  const secondState = await second.exited;
  assert.equal(secondState.code, 1, secondState.stderr + secondState.stdout);
  assert.match(secondState.stderr, /Lock error: Another ccxlog run holds the lock/);

  const firstState = await first.exited;
  assert.equal(firstState.code, 0, firstState.stderr);
  assert.equal(fs.existsSync(path.join(s.out, '.ccxlog.lock')), false);
  const after = runCli([s.project], { home: s.home });
  assert.equal(after.code, 0, after.stderr + after.stdout);
});

test('E-34b: --watch rejects --force-unlock and points at the command that clears a lock', (t) => {
  const s = scaffold(t);
  // Combining them would tear off someone else's lock on every cycle (§3.5), so
  // the exclusion is deliberate; the guidance must name an action a user can
  // actually perform.
  for (const args of [['--watch=2s', '--force-unlock'], ['--watch=2s', '--lock', '--force-unlock']]) {
    const r = runCli([s.project, ...args], { home: s.home });
    assert.equal(r.code, 2, `${args.join(' ')} -> ${r.code}\n${r.stdout}`);
    assert.match(r.stderr, /--watch cannot be combined with --force-unlock/);
    assert.match(r.stderr, /ccxlog --lock --force-unlock/);
  }
  assert.equal(fs.existsSync(path.join(s.out, 'ccxlog.md')), false);
});

test('E-34c: a watch blocked by a stale lock is told how to clear it', async (t) => {
  const s = scaffold(t);
  fs.mkdirSync(s.out, { recursive: true });
  // A lock from another host is never auto-reclaimed, so it needs the manual route.
  fs.writeFileSync(path.join(s.out, '.ccxlog.lock'), JSON.stringify({
    host: 'OTHER-HOST', pid: 424242, token: 'a'.repeat(24),
    acquiredAt: '2026-08-01T00:00:00.000Z', startedAt: '2026-08-01T00:00:00.000Z',
  }));
  const w = startWatch([s.project, '--watch=2s'], s.home);
  const st = await w.exited;
  assert.equal(st.code, 1, st.stdout);
  assert.match(st.stderr, /Lock error: Another ccxlog run holds the lock/);
  // A watch cannot --force-unlock, so it must not tell the user to re-run with it.
  assert.doesNotMatch(st.stderr, /Re-run with --force-unlock/);
  assert.match(st.stderr, /clear it first with: ccxlog --lock --force-unlock/);

  // The one-shot route the message names does work.
  const cleared = runCli([s.project, '--lock', '--force-unlock'], { home: s.home });
  assert.equal(cleared.code, 0, cleared.stderr + cleared.stdout);
});

test('E-37: a vanished source jsonl triggers exactly one auto backup, then no more', async (t) => {
  const s = scaffold(t, { codex: true, interval: 1 });
  assert.equal(runCli([s.project], { home: s.home }).code, 0);
  const backups = path.join(s.out, 'backup_CCXLOG_md_auto');
  assert.equal(fs.existsSync(backups), false);
  rmrf(path.join(s.home, '.codex'));
  const w = startWatch([s.project, '--watch'], s.home);
  assert.ok(await waitChangedCycle(w, /\[rewrite\] \(backed up 1 file\)/),
    w.state.stdout + w.state.stderr);
  await sleep(2500);
  await forceStop(w);
  assert.equal(fs.readdirSync(backups).length, 1, 'only the ccxlogid-losing cycle may back up');
});

// ---------------------------------------------------------------------------
// F. Failures, signals and exit codes (§9, §10)
// ---------------------------------------------------------------------------

test('F-39: noop cycles print nothing; the changing cycle prints one prefixed line', async (t) => {
  const s = scaffold(t, { interval: 1 });
  const w = startWatch([s.project, '--watch=4s'], s.home);
  const st = await w.exited;
  assert.equal(st.code, 0, st.stderr);
  const stamped = st.stdout.split('\n')
    .filter(l => /^\[\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\] .*pair\(s\)/.test(l));
  assert.equal(stamped.length, 1, `expected exactly one cycle line, got:\n${st.stdout}`);
  assert.match(stamped[0], /1 pair\(s\) \[create\]/);
  assert.match(st.stdout, /^ccxlog watch started /m);
  assert.match(st.stdout, /^ccxlog watch stopped \(duration elapsed\)/m);
  assert.match(st.stdout, /, 1 changed, 0 failed, ran /);
  assert.match(st.stdout, /^ {2}writes: 1 create, 0 append, 0 rewrite, [1-9]\d* noop$/m);
});

test('F-39b (§9.4): --verbose prints a start and a done line for every cycle, noop included', async (t) => {
  const s = scaffold(t, { interval: 1 });
  const w = startWatch([s.project, '--watch=3s', '--verbose'], s.home);
  const st = await w.exited;
  assert.equal(st.code, 0, st.stderr);
  const starts = st.stdout.match(/^\[[^\]]+\] cycle #\d+ start$/gm) ?? [];
  const dones = st.stdout.match(/^\[[^\]]+\] cycle #\d+ done: .*pair\(s\).*$/gm) ?? [];
  assert.ok(starts.length >= 2, st.stdout);
  assert.equal(dones.length, starts.length, 'every cycle, including the last, reports a done line');
  assert.match(dones[0], /elapsed [\d.]+s, took [\d.]+s, 1 pair\(s\), (create|noop), (next wait [\d.]+s|stopping \(no wait\))/);
  assert.match(st.stdout, /Mode: aggregate/);
});

test('F-46: a warning raised inside a cycle is reported once, with suppression, not dropped', async (t) => {
  const s = scaffold(t, { interval: 1 });
  fs.writeFileSync(path.join(s.out, 'plain.md'), '## %Question%\n\n%Answer%\n\n', 'utf-8');
  fs.writeFileSync(path.join(s.out, 'ccxlog.config.json'),
    JSON.stringify({ watchIntervalSeconds: 1, template: 'plain.md' }), 'utf-8');
  const w = startWatch([s.project, '--watch=4s'], s.home);
  const st = await w.exited;
  assert.equal(st.code, 0, st.stderr);
  const lines = st.stderr.split('\n').filter(l => /template has no %Source%/.test(l));
  assert.equal(lines.length, 1, `an identical warning appears at most once per 60 seconds:\n${st.stderr}`);
  assert.match(lines[0], /^\[\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\] Warning: template has no %Source%/);
});

test('F-41a (E17): a watch that never finds a pair still exits 0 when the duration elapses', async (t) => {
  const s = scaffold(t, { claude: false, interval: 1 });
  const w = startWatch([s.project, '--watch=2s'], s.home);
  const st = await w.exited;
  assert.equal(st.code, 0, st.stderr);
  assert.match(st.stderr, /cycle failed: no pairs collected/);
  assert.match(st.stdout, /0 changed, [1-9]\d* failed, ran /);
  assert.equal(fs.existsSync(path.join(s.out, 'ccxlog.md')), false);
});

test('F-41b (E17/B-10): a pairless watch keeps running and picks the log up on a later cycle', async (t) => {
  const s = scaffold(t, { claude: false, interval: 1 });
  const w = startWatch([s.project, '--watch'], s.home);
  assert.ok(await waitFor(() => /cycle failed: no pairs collected/.test(w.state.stderr)),
    w.state.stdout + w.state.stderr);
  writeClaudeSession(s.home, s.project, 'late.jsonl', claudeQA(s.project, { uuid: 'late' }));
  assert.ok(await waitFor(() => /recovered: cycle succeeded/.test(w.state.stdout)),
    w.state.stdout + w.state.stderr);
  assert.ok(await waitChangedCycle(w), w.state.stdout);
  await forceStop(w);
  assert.match(w.state.stdout, /recovered: cycle succeeded after \d+ failed cycle\(s\)/);
  assert.equal(countPairs(path.join(s.out, 'ccxlog.md')), 1);
});

test('F-43 (E44): SIGTERM stops gracefully with code 143',
  { skip: process.platform === 'win32' ? 'POSIX only' : false }, async (t) => {
    const s = scaffold(t);
    const w = startWatch([s.project, '--watch'], s.home);
    assert.ok(await waitStarted(w), w.state.stderr);
    await sleep(300);
    w.child.kill('SIGTERM');
    const st = await w.exited;
    assert.equal(st.code, 143, st.stderr);
    assert.match(st.stdout, /ccxlog watch stopped \(terminated \(SIGTERM\)\)/);
  });

test('F-42 (E42): Ctrl+C stops with code 130 and a summary',
  { skip: process.platform === 'win32' ? 'SIGINT cannot be delivered to a child on win32' : false }, async (t) => {
    const s = scaffold(t);
    const w = startWatch([s.project, '--watch'], s.home);
    assert.ok(await waitStarted(w), w.state.stderr);
    await sleep(300);
    w.child.kill('SIGINT');
    const st = await w.exited;
    assert.equal(st.code, 130, st.stderr);
    assert.match(st.stdout, /ccxlog watch stopped \(interrupted \(Ctrl\+C\)\)/);
  });

test('F-42b (E43): a second Ctrl+C force-quits at once, code 130',
  { skip: process.platform === 'win32' ? 'SIGINT cannot be delivered to a child on win32' : false }, async (t) => {
    const s = scaffold(t, { interval: 1 });
    const w = startWatch([s.project, '--watch'], s.home, ROOT,
      { CCXLOG_WATCH_TEST_CYCLE_DELAY_MS: '20000' });
    assert.ok(await waitStarted(w), w.state.stderr);
    await sleep(300);
    w.child.kill('SIGINT');
    assert.ok(await waitFor(() => /press Ctrl\+C again to force quit/.test(w.state.stderr), 8000),
      `the first signal must report that it is waiting for the cycle:\n${w.state.stderr}`);
    assert.equal(w.state.code, null, 'the first signal waits for the cycle to finish');
    const t0 = Date.now();
    w.child.kill('SIGINT');
    const st = await w.exited;
    assert.equal(st.code, 130, st.stderr);
    assert.ok(Date.now() - t0 < 10000,
      `the second signal must terminate immediately (took ${Date.now() - t0}ms)`);
    assert.doesNotMatch(st.stdout, /ccxlog watch stopped/);
  });

test('SMOKE/F-45 (G-51): default watch writes output and exits promptly', async (t) => {
  const s = scaffold(t);
  const w = startWatch([s.project, '--watch=2s'], s.home);
  const started = Date.now();
  const st = await w.exited;
  assert.equal(st.code, 0, st.stderr);
  assert.ok(Date.now() - started < 12000, 'the process must exit promptly after the deadline');
  assert.equal(fs.existsSync(path.join(s.out, 'ccxlog.md')), true);
  assert.equal(fs.existsSync(path.join(s.out, '.ccxlog.lock')), false);
  assert.match(st.stdout, /ccxlog watch stopped \(duration elapsed\)/);
});

// ---------------------------------------------------------------------------
// H. Incremental re-parse cache
//
// The core invariant is that with the cache enabled, the output is
// byte-identical to a cold run over the same inputs. H-2 / H-4 / H-5 / H-8
// hold it by byte-comparing the result of several watch cycles against the
// result of a single run.
// ---------------------------------------------------------------------------

function cacheFixture(t) {
  const dir = mkTmp('ccx-cache-');
  const filePath = path.join(dir, 'a.jsonl');
  fs.writeFileSync(filePath, 'x\n', 'utf-8');
  const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.utimesSync(filePath, stamp, stamp);
  if (t) t.after(() => rmrf(dir));
  const st = fs.statSync(filePath);
  return {
    dir, filePath, stamp,
    snapshot: { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino },
  };
}

function snapshotOf(filePath) {
  const st = fs.statSync(filePath);
  return { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino };
}

const STD_ROOT = { dir: '/logs', origin: 'standard', stableRootKey: 'std', recursive: false };

function cacheFile(fx, snapshot = fx.snapshot, root = STD_ROOT) {
  return { filePath: fx.filePath, root, snapshot };
}

async function primeCache(cache, fx, tag = 'first') {
  const f = cacheFile(fx);
  cache.beginCycle();
  await cache.get(cacheKey('claude', f), f);
  await cache.set(cacheKey('claude', f), f, { outcome: 'used', session: { tag } });
  cache.endCycle();
  return f;
}

function snapshotMd(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort()
    .map(f => [f, fs.readFileSync(path.join(dir, f))]);
}

function mdText(dir) {
  return snapshotMd(dir).map(([, buf]) => buf.toString('utf-8')).join('\n');
}

function restoreMd(dir, snap) {
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.md')) fs.rmSync(path.join(dir, f));
  }
  for (const [name, buf] of snap) fs.writeFileSync(path.join(dir, name), buf);
}

function assertMatchesSingleRun(s, base, extra = []) {
  const warm = snapshotMd(s.out);
  restoreMd(s.out, base ?? []);
  const r = runCli([s.project, ...extra], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const cold = snapshotMd(s.out);
  assert.deepEqual(cold.map(([n]) => n), warm.map(([n]) => n), 'the output file sets match');
  for (let i = 0; i < warm.length; i++) {
    assert.deepEqual(cold[i][1], warm[i][1],
      `cached output is byte-identical to a one-shot run: ${warm[i][0]}`);
  }
}

function cycleLines(stdout) {
  return stdout.match(/^\[[^\]]+\] cycle #\d+ done: .*$/gm) ?? [];
}

function writeLabels(stdout) {
  return cycleLines(stdout)
    .map(l => /, \d+ pair\(s\), (.+?), (?:next wait|stopping)/.exec(l)?.[1])
    .filter(v => v !== undefined);
}

function cachedCycles(stdout) {
  return cycleLines(stdout).filter(l => /cache 0 reparsed \/ [1-9]/.test(l)).length;
}

function claudeSessionPath(s) {
  const projects = path.join(s.home, '.claude', 'projects');
  return path.join(projects, fs.readdirSync(projects)[0], 'sess1.jsonl');
}

const CODEX_ROLLOUT = 'rollout-2026-05-27T11-04-49-019f-codex-0001.jsonl';

function codexRolloutPath(s) {
  return path.join(s.home, '.codex', 'sessions', '2026', '05', '27', CODEX_ROLLOUT);
}

function codexExtraQA({ q, a, ts, turn = 't2' }) {
  return [
    { type: 'turn_context', timestamp: ts, payload: { turn_id: turn, cwd: null, model: 'gpt-5' } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'task_started', turn_id: turn } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message: q } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'agent_message', message: a } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'task_complete', last_agent_message: a } },
  ];
}

test('H-1: an entry is reused only when all 4 attributes and the root are unchanged', async (t) => {
  const fx = cacheFixture(t);
  const cache = createAnalysisCache();
  const f = await primeCache(cache, fx);
  const key = cacheKey('claude', f);
  assert.deepEqual(cache.stats(), { reparsed: 1, reused: 0 }, 'the first cycle is always cold');

  cache.beginCycle();
  assert.equal((await cache.get(key, cacheFile(fx, { ...fx.snapshot }))).session.tag, 'first');
  cache.endCycle();
  assert.deepEqual(cache.stats(), { reparsed: 0, reused: 1 });

  for (const [field, value] of [['size', 99], ['mtimeMs', 1], ['dev', 987654], ['ino', 987654]]) {
    await primeCache(cache, fx);
    cache.beginCycle();
    assert.equal(await cache.get(key, cacheFile(fx, { ...fx.snapshot, [field]: value })), undefined,
      `changing ${field} triggers a re-read`);
    cache.endCycle();
    assert.deepEqual(cache.stats(), { reparsed: 1, reused: 0 }, field);
  }

  await primeCache(cache, fx);
  cache.beginCycle();
  assert.equal(await cache.get(key, { filePath: fx.filePath, root: STD_ROOT }), undefined);
  cache.endCycle();

  await primeCache(cache, fx);
  cache.beginCycle();
  const otherRoot = { dir: '/other', origin: 'standard', stableRootKey: 'std', recursive: false };
  assert.equal(await cache.get(key, cacheFile(fx, { ...fx.snapshot }, otherRoot)), undefined);
  cache.endCycle();
});

test('H-1b: unseen entries are dropped, and a changed analysis fingerprint clears everything', async (t) => {
  const fx = cacheFixture(t);
  const cache = createAnalysisCache();
  const f = await primeCache(cache, fx);
  const key = cacheKey('claude', f);
  cache.beginCycle();
  cache.endCycle();
  cache.beginCycle();
  assert.equal(await cache.get(key, cacheFile(fx, { ...fx.snapshot })), undefined, 'the entry was removed');
  cache.endCycle();

  const c2 = createAnalysisCache();
  c2.beginCycle();
  c2.useFingerprint('fp-A');
  const g = cacheFile(fx);
  await c2.get(cacheKey('claude', g), g);
  await c2.set(cacheKey('claude', g), g, { outcome: 'used', session: { tag: 'A' } });
  c2.endCycle();
  c2.beginCycle();
  c2.useFingerprint('fp-A');
  assert.ok(await c2.get(cacheKey('claude', g), g), 'the entry remains for the same fingerprint');
  c2.endCycle();
  c2.beginCycle();
  c2.useFingerprint('fp-B');
  assert.equal(await c2.get(cacheKey('claude', g), g), undefined, 'a changed fingerprint discards the entry');
  c2.endCycle();
});

test('H-1c (ported case 2): a file that changed while it was being read is not cached', async (t) => {
  //
  const fx = cacheFixture(t);
  const cache = createAnalysisCache();
  const f = cacheFile(fx);
  const key = cacheKey('claude', f);

  cache.beginCycle();
  await cache.get(key, f);
  fs.appendFileSync(fx.filePath, 'appended while reading\n', 'utf-8');
  await cache.set(key, f, { outcome: 'used', session: { tag: 'torn' } });
  cache.endCycle();

  fs.writeFileSync(fx.filePath, 'x\n', 'utf-8');
  fs.utimesSync(fx.filePath, fx.stamp, fx.stamp);
  const now = snapshotOf(fx.filePath);
  assert.deepEqual(now, fx.snapshot, 'this test requires all four attributes to return to discovery values');

  cache.beginCycle();
  assert.equal(await cache.get(key, cacheFile(fx, now)), undefined,
    'a parse from an intermediate state must not be cached');
  cache.endCycle();
});

test('H-1d (ported case 1): only sessions that reached the output keep their parsed data', async (t) => {
  const fx = cacheFixture(t);
  for (const outcome of ['prefiltered', 'unrecognized', 'dropped']) {
    const cache = createAnalysisCache();
    const f = cacheFile(fx);
    const key = cacheKey('claude', f);
    cache.beginCycle();
    await cache.get(key, f);
    await cache.set(key, f, { outcome, ...(outcome === 'unrecognized' ? {} : { pathDeps: [] }) });
    cache.endCycle();

    cache.beginCycle();
    const hit = await cache.get(key, cacheFile(fx, { ...fx.snapshot }));
    assert.equal(hit.outcome, outcome, 'the verdict is remembered without rescanning');
    assert.equal(hit.session, undefined, `${outcome} does not retain raw session data`);
    cache.endCycle();
    assert.deepEqual(cache.stats(), { reparsed: 0, reused: 1 }, outcome);
  }
});

test('H-12: an exclusion verdict is reused only while its cwd still resolves the same way', async (t) => {
  const fx = cacheFixture(t);
  for (const outcome of ['prefiltered', 'dropped']) {
    const cache = createAnalysisCache();
    const f = cacheFile(fx);
    const key = cacheKey('codex', f);
    const raw = fx.dir;

    cache.beginCycle();
    await cache.get(key, f);
    await cache.set(key, f, { outcome, pathDeps: [{ raw, canon: await canonicalPath(raw) }] });
    cache.endCycle();

    cache.beginCycle();
    const hit = await cache.get(key, cacheFile(fx, { ...fx.snapshot }));
    assert.equal(hit?.outcome, outcome, `${outcome}: equal resolution results allow reuse`);
    cache.endCycle();
    assert.deepEqual(cache.stats(), { reparsed: 0, reused: 1 }, outcome);

    cache.beginCycle();
    await cache.set(key, f, { outcome, pathDeps: [{ raw, canon: `${await canonicalPath(raw)}-relinked` }] });
    cache.endCycle();
    cache.beginCycle();
    assert.equal(await cache.get(key, cacheFile(fx, { ...fx.snapshot })), undefined,
      `${outcome}: a changed cwd resolution must invalidate the old exclusion verdict`);
    cache.endCycle();
    assert.deepEqual(cache.stats(), { reparsed: 1, reused: 0 }, outcome);
  }
});

test('H-2 [regression]: cached cycles reproduce create / noop / append / rewrite and the final bytes', async (t) => {
  for (const extra of [[], ['-cc'], ['-cx'], ['--per-session']]) {
    const label = extra.join(' ') || 'both';
    const s = scaffold(t, { codex: true, interval: 1 });
    const cc = claudeSessionPath(s);
    const cx = codexRolloutPath(s);
    const w = startWatch([s.project, '--watch', '--verbose', ...extra], s.home);
    const trace = () => `${label}\n${w.state.stdout}\n${w.state.stderr}`;

    assert.ok(await waitFor(() => fs.existsSync(s.out) && snapshotMd(s.out).length > 0, 20000),
      `${label}: output was not created\n${trace()}`);
    assert.ok(await waitFor(() => cachedCycles(w.state.stdout) >= 1, 20000),
      `${label}: no cycle used the cache\n${trace()}`);

    fs.appendFileSync(cc, claudeQA(s.project, {
      q: 'Second question', a: 'Second answer', uuid: 'u2', ts: '2026-05-27T11:10:49.000Z',
    }).map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    fs.appendFileSync(cx, codexExtraQA({
      q: 'Second question', a: 'Second answer', ts: '2026-05-27T11:11:49.000Z',
    }).map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    assert.ok(await waitFor(() => mdText(s.out).includes('Second answer'), 20000),
      `${label}: append was not reflected\n${trace()}`);
    assert.ok(await waitFor(() => cachedCycles(w.state.stdout) >= 2, 20000),
      `${label}: no cached cycle occurred after the append\n${trace()}`);

    const base = snapshotMd(s.out);
    const ccHead = claudeQA(s.project, { a: 'Yo from Claude' }).map(r => JSON.stringify(r)).join('\n');
    const ccTail = fs.readFileSync(cc, 'utf-8').split('\n').slice(2).join('\n');
    fs.writeFileSync(cc, `${ccHead}\n${ccTail}`, 'utf-8');
    const cxLines = fs.readFileSync(cx, 'utf-8').split('\n');
    fs.writeFileSync(cx, cxLines.map(l => l.replace('"Hi from Codex"', '"Yo from Codex"')).join('\n'), 'utf-8');
    assert.ok(await waitFor(() => /Yo from/.test(mdText(s.out)), 20000),
      `${label}: replacement was not reflected\n${trace()}`);
    await forceStop(w);

    const labels = writeLabels(w.state.stdout).join(' | ');
    for (const kind of ['create', 'noop', 'append', 'rewrite']) {
      assert.ok(labels.includes(kind), `${label}: no ${kind} cycle was observed\n${labels}`);
    }
    const cacheLines = w.state.stdout.match(/cache \d+ reparsed \/ \d+ reused/g) ?? [];
    assert.ok(cacheLines.length >= 2, `${label}: fewer than two cycles ran\n${w.state.stdout}`);
    assert.match(cacheLines[0], /cache [1-9]\d* reparsed \/ 0 reused/, `${label}: the first cycle is cold`);
    assert.ok(cachedCycles(w.state.stdout) >= 2, `${label}: too few zero-reparse cycles`);

    assertMatchesSingleRun(s, base, extra);
    assertMatchesSingleRun(s, null, extra);
  }
});

test('H-3 (requirement 7): --verbose reports the reparsed / reused split for every cycle', async (t) => {
  const s = scaffold(t, { codex: true, interval: 1 });
  const w = startWatch([s.project, '--watch=4s', '--verbose'], s.home);
  const st = await w.exited;
  assert.equal(st.code, 0, st.stderr);
  const dones = cycleLines(st.stdout);
  assert.ok(dones.length >= 2, st.stdout);
  assert.ok(dones.every(l => /cache \d+ reparsed \/ \d+ reused$/.test(l)), dones.join('\n'));
  assert.match(dones[0], /cache 2 reparsed \/ 0 reused$/);      // claude 1 + codex 1
  assert.match(dones[1], /cache 0 reparsed \/ 2 reused$/);
  assert.match(st.stdout, /^\[claude\] files: 1, fully read: 1, sessions kept: 1, reparsed: 0, reused: 1$/m);
});

test('H-4 [regression]: an appended file is reparsed and still matches a single run', async (t) => {
  const s = scaffold(t, { interval: 1 });
  const jsonl = path.join(s.home, '.claude', 'projects',
    fs.readdirSync(path.join(s.home, '.claude', 'projects'))[0], 'sess1.jsonl');
  const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.utimesSync(jsonl, stamp, stamp);
  const w = startWatch([s.project, '--watch'], s.home);
  const agg = path.join(s.out, 'ccxlog.md');
  assert.ok(await waitChangedCycle(w), w.state.stdout + w.state.stderr);
  assert.equal(countPairs(agg), 1);
  const base = snapshotMd(s.out);

  const added = claudeQA(s.project, { q: 'Second question', a: 'Second answer', uuid: 'u2', ts: '2026-05-27T11:05:49.000Z' });
  fs.appendFileSync(jsonl, added.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  fs.utimesSync(jsonl, stamp, stamp);
  assert.equal(fs.statSync(jsonl).mtimeMs, stamp.getTime(), 'this test requires mtime to remain unchanged');

  assert.ok(await waitFor(() => fs.existsSync(agg) && countPairs(agg) === 2, 20000),
    `the append was not reflected in the next cycle\n${w.state.stdout}\n${w.state.stderr}`);
  await forceStop(w);
  assertMatchesSingleRun(s, base);
});


test('H-5 [regression]: a removed file leaves the cache and the output, matching a single run', async (t) => {
  const s = scaffold(t, { interval: 1 });
  const projects = path.join(s.home, '.claude', 'projects');
  const dir = path.join(projects, fs.readdirSync(projects)[0]);
  writeJsonl(path.join(dir, 'sess2.jsonl'),
    claudeQA(s.project, { q: 'From the second session', a: 'Answer 2', uuid: 'v1', ts: '2026-05-27T11:06:49.000Z' }));
  const w = startWatch([s.project, '--watch'], s.home);
  const agg = path.join(s.out, 'ccxlog.md');
  assert.ok(await waitFor(() => fs.existsSync(agg) && countPairs(agg) === 2, 20000),
    w.state.stdout + w.state.stderr);
  const base = snapshotMd(s.out);

  fs.rmSync(path.join(dir, 'sess2.jsonl'));
  assert.ok(await waitFor(() => countPairs(agg) === 1, 20000),
    `the removal was not reflected\n${w.state.stdout}\n${w.state.stderr}`);
  await forceStop(w);
  assertMatchesSingleRun(s, base);
});

test('H-6 [regression]: an in-place replacement of the same size is reparsed', async (t) => {
  const s = scaffold(t, { interval: 1 });
  const projects = path.join(s.home, '.claude', 'projects');
  const jsonl = path.join(projects, fs.readdirSync(projects)[0], 'sess1.jsonl');
  const w = startWatch([s.project, '--watch'], s.home);
  const agg = path.join(s.out, 'ccxlog.md');
  assert.ok(await waitChangedCycle(w), w.state.stdout + w.state.stderr);
  assert.match(fs.readFileSync(agg, 'utf-8'), /Hi from Claude/);
  const base = snapshotMd(s.out);

  const replaced = claudeQA(s.project, { a: 'Yo from Claude' });
  fs.writeFileSync(jsonl, replaced.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  assert.ok(await waitFor(() => /Yo from Claude/.test(fs.readFileSync(agg, 'utf-8')), 20000),
    `the replacement was not reflected\n${w.state.stdout}\n${w.state.stderr}`);
  await forceStop(w);
  assertMatchesSingleRun(s, base);
});

test('H-7 (requirement 4): the Codex prefilter verdict is cached too', async (t) => {
  const s = scaffold(t, { interval: 1 });
  const other = path.join(s.home, 'other-project');
  fs.mkdirSync(other, { recursive: true });
  writeCodexSession(s.home, 'rollout-2026-05-27T11-04-49-019f-codex-9999.jsonl', codexQA(other));
  const w = startWatch([s.project, '--watch=4s', '--verbose'], s.home);
  const st = await w.exited;
  assert.equal(st.code, 0, st.stderr);
  assert.match(st.stdout, /^\[codex\] files: 1, fully read: 0, sessions kept: 0, reparsed: 0, reused: 1$/m);
  const dones = st.stdout.match(/cache \d+ reparsed \/ \d+ reused/g) ?? [];
  assert.ok(dones.length >= 2, st.stdout);
  assert.ok(dones.slice(1).every(l => l === 'cache 0 reparsed / 2 reused'),
    `the prefilter must not rescan after the first cycle\n${dones.join('\n')}`);
  assert.equal(countPairs(path.join(s.out, 'ccxlog.md')), 1, 'pairs from other projects are excluded');
});

test('H-8 [regression]: changing the analysis inputs invalidates the cached prefilter verdict', async (t) => {
  const s = scaffold(t, { interval: 1 });
  const other = path.join(s.home, 'other-project');
  fs.mkdirSync(other, { recursive: true });
  writeCodexSession(s.home, 'rollout-2026-05-27T11-04-49-019f-codex-9999.jsonl', codexQA(other));
  const w = startWatch([s.project, '--watch'], s.home);
  const agg = path.join(s.out, 'ccxlog.md');
  assert.ok(await waitFor(() => fs.existsSync(agg) && countPairs(agg) === 1, 20000),
    w.state.stdout + w.state.stderr);
  const base = snapshotMd(s.out);

  fs.writeFileSync(path.join(s.out, 'ccxlog.config.json'),
    JSON.stringify({ watchIntervalSeconds: 1, extraCwds: [other] }), 'utf-8');
  assert.ok(await waitFor(() => countPairs(agg) === 2, 20000),
    `the old prefilter verdict remained after a configuration change\n${w.state.stdout}\n${w.state.stderr}`);
  await forceStop(w);
  assertMatchesSingleRun(s, base);
});

test('H-9: a mixed Claude + Codex + foreign-Codex tree reuses every file after the first cycle', async (t) => {
  const s = scaffold(t, { codex: true, interval: 1 });
  const other = path.join(s.home, 'other-project');
  fs.mkdirSync(other, { recursive: true });
  writeCodexSession(s.home, 'rollout-2026-05-27T11-04-49-019f-codex-9999.jsonl',
    codexQA(other, { q: 'Foreign question', a: 'Foreign answer', sessionId: '019f-codex-9999' }));
  const w = startWatch([s.project, '--watch', '--verbose'], s.home);

  assert.ok(await waitFor(() => cachedCycles(w.state.stdout) >= 1, 20000),
    w.state.stdout + w.state.stderr);
  await forceStop(w);

  const dones = w.state.stdout.match(/cache \d+ reparsed \/ \d+ reused/g) ?? [];
  assert.match(dones[0], /^cache 3 reparsed \/ 0 reused$/, `the first cycle is cold\n${dones.join('\n')}`);
  assert.ok(dones.slice(1).every(l => l === 'cache 0 reparsed / 3 reused'),
    `all three files must be reused after the first cycle\n${dones.join('\n')}`);
  assert.match(w.state.stdout, /^\[claude\] files: 1, fully read: 1, sessions kept: 1, reparsed: 0, reused: 1$/m);
  assert.match(w.state.stdout, /^\[codex\] files: 2, fully read: 1, sessions kept: 1, reparsed: 0, reused: 2$/m);

  const agg = path.join(s.out, 'ccxlog.md');
  assert.equal(countPairs(agg), 2, 'pairs from other projects are excluded');
  assert.doesNotMatch(fs.readFileSync(agg, 'utf-8'), /Foreign question/);
});

test('H-9b: a Codex thread rename is rendered without reparsing the rollout', async (t) => {
  const s = scaffold(t, { claude: false, codex: true, interval: 1 });
  const sessionId = '019f-codex-0001';
  writeCodexSessionIndex(s.home, [{ id: sessionId, thread_name: 'Codex1' }]);
  const w = startWatch([s.project, '-cx', '--watch', '--verbose'], s.home);
  const agg = path.join(s.out, 'cxlog.md');

  assert.ok(await waitFor(() => fs.existsSync(agg)
    && /Session:Codex1:019f-codex-0001/.test(fs.readFileSync(agg, 'utf-8')), 20000),
  w.state.stdout + w.state.stderr);

  writeCodexSessionIndex(s.home, [{ id: sessionId, thread_name: 'Renamed Codex' }]);
  assert.ok(await waitFor(() => /Session:Renamed Codex:019f-codex-0001/
    .test(fs.readFileSync(agg, 'utf-8')), 20000),
  `the changed session index was not reflected\n${w.state.stdout}\n${w.state.stderr}`);
  await forceStop(w);

  assert.doesNotMatch(fs.readFileSync(agg, 'utf-8'), /Session:Codex1:/);
  assert.match(w.state.stdout, /cache 0 reparsed \/ 1 reused/,
    'the external rename must not force the unchanged rollout through the parser');
});

test('H-11 (ported case 1): a format-mismatched file is remembered by its verdict, not re-read', async (t) => {
  const s = scaffold(t, { interval: 1 });
  const logs = path.join(s.home, 'mixed');
  writeJsonl(path.join(logs, 'junk.jsonl'), [{ kind: 'metrics', value: 42 }]);
  fs.writeFileSync(path.join(s.out, 'ccxlog.config.json'),
    JSON.stringify({ watchIntervalSeconds: 1, claude: { extraLogDirs: [logs] } }), 'utf-8');

  const w = startWatch([s.project, '-cc', '--watch', '--verbose'], s.home);
  assert.ok(await waitFor(() => cachedCycles(w.state.stdout) >= 1, 20000),
    w.state.stdout + w.state.stderr);
  await forceStop(w);

  const dones = w.state.stdout.match(/cache \d+ reparsed \/ \d+ reused/g) ?? [];
  assert.match(dones[0], /^cache 2 reparsed \/ 0 reused$/, dones.join('\n'));
  assert.ok(dones.slice(1).every(l => l === 'cache 0 reparsed / 2 reused'),
    `format-mismatched files must not be re-read\n${dones.join('\n')}`);
  const discovery = w.state.stdout.match(/^\[claude\] files: .*$/gm) ?? [];
  assert.ok(discovery.length >= 2, w.state.stdout);
  assert.match(discovery[1],
    /^\[claude\] files: 2, fully read: 2, sessions kept: 1, reparsed: 0, reused: 2, format-skipped: 1$/);
  assert.match(w.state.stdout, /skipped \(not claude-format\).*junk\.jsonl/);
  assert.equal(countPairs(path.join(s.out, 'cclog.md')), 1);
});

function linkDir(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function unlinkDir(link) {
  try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); }
}

test('H-10 [regression]: re-pointing a symlink is reflected on the next cycle', async (t) => {
  const home = mkTmp('ccx-watch-sym-');
  t.after(() => { killLiveWatches(); rmrf(home); });
  const projA = path.join(home, 'projA');
  const projB = path.join(home, 'projB');
  const out = path.join(home, 'out');
  for (const d of [projA, projB, out]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(out, 'ccxlog.config.json'),
    JSON.stringify({ watchIntervalSeconds: 1 }), 'utf-8');

  const link = path.join(home, 'link');
  try {
    linkDir(projA, link);
  } catch (e) {
    t.skip(`symlinks not permitted on this host: ${e.code}`);
    return;
  }

  writeCodexSession(home, 'rollout-2026-05-27T11-04-49-019f-codex-000a.jsonl',
    codexQA(projA, { q: 'Question A', a: 'Answer A', sessionId: '019f-codex-000a' }));
  writeCodexSession(home, 'rollout-2026-05-27T11-05-49-019f-codex-000b.jsonl',
    codexQA(projB, { q: 'Question B', a: 'Answer B', sessionId: '019f-codex-000b' }));

  const w = startWatch([link, '-cx', '--out', out, '--watch'], home);
  const agg = path.join(out, 'cxlog.md');
  assert.ok(await waitFor(() => fs.existsSync(agg) && /Question A/.test(fs.readFileSync(agg, 'utf-8')), 20000),
    w.state.stdout + w.state.stderr);
  assert.doesNotMatch(fs.readFileSync(agg, 'utf-8'), /Question B/);

  unlinkDir(link);
  linkDir(projB, link);

  assert.ok(await waitFor(() => /Question B/.test(fs.readFileSync(agg, 'utf-8')), 20000),
    `the symlink update was not reflected in the next cycle\n${w.state.stdout}\n${w.state.stderr}`);
  assert.doesNotMatch(fs.readFileSync(agg, 'utf-8'), /Question A/);
  await forceStop(w);
});

test('H-13 [regression]: re-pointing the SESSION cwd link invalidates the cached exclusion', async (t) => {
  //
  const home = mkTmp('ccx-watch-cwdsym-');
  t.after(() => { killLiveWatches(); rmrf(home); });
  const project = path.join(home, 'proj');
  const other = path.join(home, 'other');
  const out = path.join(home, 'out');
  for (const d of [project, other, out]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(out, 'ccxlog.config.json'),
    JSON.stringify({ watchIntervalSeconds: 1 }), 'utf-8');

  const link = path.join(home, 'session-cwd');
  try {
    linkDir(other, link);
  } catch (e) {
    t.skip(`symlinks not permitted on this host: ${e.code}`);
    return;
  }
  const rollout = 'rollout-2026-05-27T11-04-49-019f-codex-000s.jsonl';
  writeCodexSession(home, rollout,
    codexQA(link, { q: 'Question S', a: 'Answer S', sessionId: '019f-codex-000s' }));
  const jsonl = path.join(home, '.codex', 'sessions', '2026', '05', '27', rollout);
  const before = snapshotOf(jsonl);

  const w = startWatch([project, '-cx', '--out', out, '--watch', '--verbose'], home);
  const agg = path.join(out, 'cxlog.md');

  assert.ok(await waitFor(() => cachedCycles(w.state.stdout) >= 1, 20000),
    w.state.stdout + w.state.stderr);
  assert.match(w.state.stdout,
    /^\[codex\] files: 1, fully read: 0, sessions kept: 0, reparsed: 0, reused: 1$/m);
  assert.ok(!fs.existsSync(agg), 'no output is created while the session is out of scope');
  const base = snapshotMd(out);

  unlinkDir(link);
  linkDir(project, link);
  assert.deepEqual(snapshotOf(jsonl), before,
    'this test requires all four log-file attributes to remain unchanged');

  assert.ok(await waitFor(() => fs.existsSync(agg) && /Question S/.test(fs.readFileSync(agg, 'utf-8')), 20000),
    `the session cwd update was not reflected because an old exclusion verdict was reused\n${w.state.stdout}\n${w.state.stderr}`);
  await forceStop(w);
  assertMatchesSingleRun({ home, project, out }, base, ['-cx', '--out', out]);
});

test('H-14 [regression]: re-pointing a link behind a DROPPED verdict invalidates the cached exclusion', async (t) => {
  //
  //
  //
  //
  const home = fs.realpathSync(mkTmp('ccx-watch-cwddrop-'));
  t.after(() => { killLiveWatches(); rmrf(home); });
  const project = path.join(home, 'proj');
  const inside = path.join(project, 'real');
  const other = path.join(home, 'other');
  const out = path.join(home, 'out');
  for (const d of [project, inside, other, out]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(out, 'ccxlog.config.json'),
    JSON.stringify({ watchIntervalSeconds: 1 }), 'utf-8');

  const link = path.join(project, 'sub');
  try {
    linkDir(other, link);
  } catch (e) {
    t.skip(`symlinks not permitted on this host: ${e.code}`);
    return;
  }
  const rollout = 'rollout-2026-05-27T11-04-49-019f-codex-000d.jsonl';
  writeCodexSession(home, rollout,
    codexQA(link, { q: 'Question D', a: 'Answer D', sessionId: '019f-codex-000d' }));
  const jsonl = path.join(home, '.codex', 'sessions', '2026', '05', '27', rollout);
  const before = snapshotOf(jsonl);

  const w = startWatch([project, '-cx', '--out', out, '--watch', '--verbose'], home);
  const agg = path.join(out, 'cxlog.md');

  assert.ok(await waitFor(() => cachedCycles(w.state.stdout) >= 1, 20000),
    w.state.stdout + w.state.stderr);
  assert.match(w.state.stdout,
    /^\[codex\] files: 1, fully read: 1, sessions kept: 0, reparsed: 0, reused: 1$/m);
  assert.ok(!fs.existsSync(agg), 'no output is created while the session is out of scope');
  const base = snapshotMd(out);

  unlinkDir(link);
  linkDir(inside, link);
  assert.deepEqual(snapshotOf(jsonl), before,
    'this test requires all four log-file attributes to remain unchanged');

  assert.ok(await waitFor(() => fs.existsSync(agg) && /Question D/.test(fs.readFileSync(agg, 'utf-8')), 20000),
    `the cwd link update was not reflected because an old dropped verdict was reused\n${w.state.stdout}\n${w.state.stderr}`);
  await forceStop(w);
  assertMatchesSingleRun({ home, project, out }, base, ['-cx', '--out', out]);
});
