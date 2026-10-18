// Stopping running watches from another terminal: `ccxlog --stop` (the watch
// that owns one output directory) and `ccxlog --stop-all` (every watch started
// in this environment).
//
// A watch is asked to stop, not killed. `--stop` writes the lock's token into
// `<out>/.ccxlog.stop`; the watch checks for it while it waits between cycles,
// then shuts down exactly as on Ctrl+C (the summary is printed and the lock is
// released). This works on Windows, where a process cannot be sent SIGTERM, and
// across environments that share the folder (a watch inside a devcontainer can
// be stopped from the host). Only a watch that cannot be asked — one started by
// a version before v1.12.0, or one that does not respond in time — is
// terminated by pid, and only after its pid is confirmed to be a ccxlog process
// in this very environment, so a recycled pid is never killed.
//
// `--stop-all` needs to know where the watches are. Each watch registers itself
// in `~/.ccxlog/watches/` for its lifetime. Windows, WSL and every container have
// their own home folder and process table, so `--stop-all` reaches the watches
// of the environment it runs in.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  lockPath, pidAlive, readLock, removeLockIfUnchanged, runtimeEnv, sameEnvironment,
} from './lock.js';
import type { OutputSink } from './outputSink.js';

const STOP_FILE = '.ccxlog.stop';
const DEFAULT_STOP_TIMEOUT_MS = 60_000;
// How often a waiting watch looks for a stop request.
export const STOP_POLL_MS = 500;

export type StopResult = 'stopped' | 'none' | 'stale' | 'failed';

export function stopRequestPath(outDir: string): string {
  return path.join(outDir, STOP_FILE);
}

// How long --stop waits for a watch to finish its current cycle and exit. A
// cold cycle over a large history can take tens of seconds.
function stopTimeoutMs(): number {
  const n = Number(process.env.CCXLOG_STOP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STOP_TIMEOUT_MS;
}

// ---- watch side ------------------------------------------------------------

export async function stopRequested(outDir: string, token: string): Promise<boolean> {
  const raw = await fs.readFile(stopRequestPath(outDir), 'utf-8').catch(() => null);
  return raw !== null && raw.trim() === token;
}

// Remove the stop request. With a token, only a request addressed to that
// holder is removed (another stopper may already be addressing the next one).
export async function clearStopRequest(outDir: string, token?: string): Promise<void> {
  if (token !== undefined && !(await stopRequested(outDir, token))) return;
  await fs.rm(stopRequestPath(outDir), { force: true }).catch(() => undefined);
}

export interface WatchEntry {
  host: string;
  env: string;
  pid: number;
  outDir: string;
  projectPath: string;
  token: string | null;   // the lock token; null for a --dry-run watch, which holds no lock
  startedAt: string;
}

function registryDir(): string {
  return path.join(os.homedir(), '.ccxlog', 'watches');
}

function entryFileName(host: string, env: string, pid: number): string {
  return `${`${host}-${env}`.replace(/[^A-Za-z0-9._-]/g, '_')}-${pid}.json`;
}

// Best effort: a watch whose registration fails still runs; it just cannot be
// reached by --stop-all (--stop still works through its lock).
export async function registerWatch(entry: Omit<WatchEntry, 'host' | 'env' | 'pid' | 'startedAt'>): Promise<string | null> {
  const full: WatchEntry = {
    host: os.hostname(),
    env: runtimeEnv(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...entry,
  };
  const file = path.join(registryDir(), entryFileName(full.host, full.env, full.pid));
  try {
    await fs.mkdir(registryDir(), { recursive: true });
    await fs.writeFile(file, JSON.stringify(full, null, 2) + '\n', 'utf-8');
    return file;
  } catch {
    return null;
  }
}

export async function unregisterWatch(file: string | null): Promise<void> {
  if (file) await fs.rm(file, { force: true }).catch(() => undefined);
}

async function listWatchEntries(): Promise<Array<{ file: string; entry: WatchEntry }>> {
  let names: string[];
  try {
    names = (await fs.readdir(registryDir())).filter(n => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const found: Array<{ file: string; entry: WatchEntry }> = [];
  for (const n of names) {
    const file = path.join(registryDir(), n);
    try {
      const e = JSON.parse(await fs.readFile(file, 'utf-8')) as WatchEntry;
      if (typeof e.pid === 'number' && typeof e.outDir === 'string' && typeof e.host === 'string') {
        found.push({ file, entry: e });
      }
    } catch {
      // Half-written or foreign file: not an entry.
    }
  }
  return found;
}

// ---- process identity --------------------------------------------------------

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

async function commandLineOf(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    const raw = await fs.readFile(`/proc/${pid}/cmdline`, 'utf-8').catch(() => null);
    if (raw !== null) return raw.replace(/\0/g, ' ').trim();
  }
  if (process.platform === 'win32') {
    return run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]);
  }
  return run('ps', ['-o', 'command=', '-p', String(pid)]);
}

// true / false when the command line could be read; null when it could not.
async function isCcxlogProcess(pid: number): Promise<boolean | null> {
  const cmd = await commandLineOf(pid);
  if (cmd === null) return null;
  return /ccxlog/i.test(cmd);
}

// ---- stopping ----------------------------------------------------------------

// Wait until the lock no longer holds `raw` (released or replaced), or — when
// the holder is in this environment — its pid is gone.
async function waitReleased(outDir: string, raw: string, pid: number | null, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const now = await fs.readFile(lockPath(outDir), 'utf-8').catch(() => null);
    if (now !== raw) return true;
    if (pid !== null && !pidAlive(pid)) return true;
    if (Date.now() >= end) return false;
    await delay(200);
  }
}

async function waitGone(pid: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() >= end) return false;
    await delay(100);
  }
  return true;
}

// Terminate a confirmed local ccxlog process. On POSIX, SIGTERM makes a watch
// shut down gracefully; on Windows it ends the process at once.
async function terminate(pid: number, timeoutMs: number): Promise<boolean> {
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  if (await waitGone(pid, timeoutMs)) return true;
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    return waitGone(pid, 5_000);
  }
  return false;
}

async function unregisterPid(pid: number): Promise<void> {
  for (const { file, entry } of await listWatchEntries()) {
    if (entry.pid === pid && sameEnvironment(entry)) await unregisterWatch(file);
  }
}

// Stop whatever holds the lock in `outDir`.
export async function stopOutDir(outDir: string, out: OutputSink, timeoutMs = stopTimeoutMs()): Promise<StopResult> {
  const lock = await readLock(outDir);
  if (!lock) {
    const exists = await fs.stat(lockPath(outDir)).then(() => true, () => false);
    if (exists) {
      out.error(`${lockPath(outDir)} is not a readable ccxlog lock. If no ccxlog is running for this folder, clear it with: ccxlog --lock --force-unlock`);
      return 'failed';
    }
    out.log(`No ccxlog is running for ${outDir}.`);
    return 'none';
  }
  const { info, raw } = lock;
  const here = sameEnvironment(info);
  const who = `pid ${info.pid} on ${info.host}${info.env ? ` (${info.env})` : ''}`;
  if (here && info.pid === process.pid) {
    out.error(`The lock in ${outDir} is held by this process.`);
    return 'failed';
  }

  // A holder that is gone (or whose pid now belongs to another program) left a
  // stale lock. It is removed only when the lock names its runtime: an older
  // lock may come from WSL seen from Windows, whose pids this side cannot see.
  const stale = async (): Promise<StopResult> => {
    if (info.env !== undefined && await removeLockIfUnchanged(outDir, raw)) {
      await clearStopRequest(outDir, info.token);
      await unregisterPid(info.pid);
      out.log(`Removed a stale lock in ${outDir} (${who} is no longer running).`);
      return 'stale';
    }
    out.error(`The lock in ${outDir} names ${who}, which is not running here. `
      + 'If no ccxlog is running for this folder, clear it with: ccxlog --lock --force-unlock');
    return 'failed';
  };
  if (here && !pidAlive(info.pid)) return stale();

  if (info.stoppable) {
    out.log(`Asking ccxlog (${who}) to stop: ${outDir}`);
    await fs.writeFile(stopRequestPath(outDir), info.token, 'utf-8');
    if (await waitReleased(outDir, raw, here ? info.pid : null, timeoutMs)) {
      await clearStopRequest(outDir, info.token);
      if (here && !pidAlive(info.pid)) await removeLockIfUnchanged(outDir, raw);
      out.log(`Stopped ccxlog (${who}).`);
      return 'stopped';
    }
    if (!here) {
      await clearStopRequest(outDir, info.token);
      out.error(`ccxlog (${who}) did not stop within ${Math.round(timeoutMs / 1000)}s. `
        + 'It runs in another environment; run ccxlog --stop there.');
      return 'failed';
    }
    out.log(`ccxlog (${who}) did not stop within ${Math.round(timeoutMs / 1000)}s; terminating it.`);
  } else if (!here) {
    out.error(`The lock in ${outDir} is held by ${who}, in another environment, `
      + 'by a ccxlog that cannot be asked to stop. Stop it from that environment.');
    return 'failed';
  }

  const isCcxlog = await isCcxlogProcess(info.pid);
  if (isCcxlog === false) return stale();
  if (isCcxlog === null) {
    out.error(`Could not confirm that pid ${info.pid} is ccxlog; not stopping it.`);
    return 'failed';
  }
  if (!info.stoppable) out.log(`Terminating ccxlog (${who}): ${outDir}`);
  if (!(await terminate(info.pid, timeoutMs))) {
    out.error(`ccxlog (${who}) is still running.`);
    return 'failed';
  }
  await removeLockIfUnchanged(outDir, raw);
  await clearStopRequest(outDir, info.token);
  await unregisterPid(info.pid);
  out.log(`Stopped ccxlog (${who}).`);
  return 'stopped';
}

// Stop one registered watch. A watch whose lock is still its own is stopped
// through that lock; one without a lock (a --dry-run watch) is terminated by pid.
async function stopEntry(file: string, e: WatchEntry, out: OutputSink, timeoutMs: number): Promise<StopResult> {
  const lock = e.token === null ? null : await readLock(e.outDir);
  const ownsLock = lock !== null && lock.info.token === e.token && lock.info.pid === e.pid;
  if (!pidAlive(e.pid)) {
    await unregisterWatch(file);
    if (ownsLock) await removeLockIfUnchanged(e.outDir, lock.raw);
    out.log(`Removed a stale entry for ${e.outDir} (pid ${e.pid} is no longer running).`);
    return 'stale';
  }
  if (ownsLock) {
    const r = await stopOutDir(e.outDir, out, timeoutMs);
    if (r !== 'failed') await unregisterWatch(file);
    return r;
  }
  const isCcxlog = await isCcxlogProcess(e.pid);
  if (isCcxlog === false) {
    await unregisterWatch(file);
    out.log(`Removed a stale entry for ${e.outDir} (pid ${e.pid} is no longer ccxlog).`);
    return 'stale';
  }
  if (isCcxlog === null) {
    out.error(`Could not confirm that pid ${e.pid} is ccxlog; not stopping it (${e.outDir}).`);
    return 'failed';
  }
  out.log(`Terminating ccxlog (pid ${e.pid}): ${e.outDir}`);
  if (!(await terminate(e.pid, timeoutMs))) {
    out.error(`ccxlog (pid ${e.pid}) is still running.`);
    return 'failed';
  }
  await unregisterWatch(file);
  out.log(`Stopped ccxlog (pid ${e.pid}).`);
  return 'stopped';
}

export async function stopAll(out: OutputSink, timeoutMs = stopTimeoutMs()): Promise<StopResult[]> {
  const entries = await listWatchEntries();
  const here = entries.filter(({ entry }) => entry.env !== undefined && sameEnvironment(entry) && entry.pid !== process.pid);
  const elsewhere = entries.length - here.length;
  if (here.length === 0) {
    out.log('No running ccxlog watch is registered in this environment.');
  } else {
    out.log(`Stopping ${here.length} ccxlog watch(es)...`);
  }
  // In parallel, since each may first finish a cycle; each one's lines are
  // printed together, in registry order.
  const results = await Promise.all(here.map(async ({ file, entry }) => {
    const lines: Array<{ err: boolean; text: string }> = [];
    const sink: OutputSink = {
      log: (m: string) => { lines.push({ err: false, text: m }); },
      warn: (m: string) => { lines.push({ err: true, text: m }); },
      error: (m: string) => { lines.push({ err: true, text: m }); },
    };
    const r = await stopEntry(file, entry, sink, timeoutMs);
    return { r, lines };
  }));
  for (const { lines } of results) {
    for (const l of lines) (l.err ? out.error : out.log)(`  ${l.text}`);
  }
  if (elsewhere > 0) {
    out.log(`${elsewhere} registered watch(es) belong to another host or environment; run ccxlog --stop-all there.`);
  }
  return results.map(x => x.r);
}
