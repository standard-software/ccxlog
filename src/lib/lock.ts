import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const LOCK_FILE = '.ccxlog.lock';

export interface LockHandle {
  filePath: string;
  token: string;
}

interface LockInfo {
  host: string;
  pid: number;
  token: string;
  acquiredAt: string;
  startedAt: string;   // approximate process start time (§8.6)
}

// Approximate the current process start time from its uptime. Recorded so a
// future holder can reason about PID-reuse (§8.6).
function processStartedAt(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

function lockPath(outDir: string): string {
  return path.join(outDir, LOCK_FILE);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means the process exists but we can't signal it.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function looksValid(info: LockInfo): boolean {
  return typeof info.host === 'string'
    && typeof info.pid === 'number'
    && /^[0-9a-f]{24}$/.test(info.token ?? '')
    && Number.isFinite(Date.parse(info.acquiredAt));
}

// Acquire an exclusive lock (§8.6). Conservative: a lock held by another host
// or a possibly-live PID is respected. Automatic reclaim happens only when the
// evidence is unambiguous — same host, dead PID, well-formed lock — and even
// then only via a compare-and-swap (re-read the exact bytes just before rm) so
// we never delete a lock a fresh run wrote between our read and our remove.
// Otherwise stop on the safe side; --force-unlock is the only manual override.
export async function acquireLock(outDir: string, forceUnlock: boolean): Promise<{ handle?: LockHandle; error?: string }> {
  const filePath = lockPath(outDir);
  const token = crypto.randomBytes(12).toString('hex');
  const info: LockInfo = {
    host: os.hostname(),
    pid: process.pid,
    token,
    acquiredAt: new Date().toISOString(),
    startedAt: processStartedAt(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fs.open(filePath, 'wx');
      await fh.writeFile(JSON.stringify(info), 'utf-8');
      await fh.close();
      return { handle: { filePath, token } };
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    // Lock exists — inspect it.
    const rawExisting = await fs.readFile(filePath, 'utf-8').catch(() => '');
    let existing: LockInfo | null = null;
    try { existing = JSON.parse(rawExisting) as LockInfo; } catch { existing = null; }

    if (forceUnlock) {
      await fs.rm(filePath, { force: true });
      continue; // retry acquisition
    }

    const sameHost = existing ? existing.host === os.hostname() : false;
    if (existing && sameHost && looksValid(existing) && !pidAlive(existing.pid)) {
      // Same host, well-formed lock, and the holder PID is not running at all —
      // the original holder is unambiguously gone (PID-reuse only matters when a
      // process still occupies the id, which pidAlive would have reported). This
      // is the "明白に安全" case §8.6 permits. Compare-and-swap: only remove if
      // the on-disk bytes still equal what we inspected.
      const unchanged = await fs.readFile(filePath, 'utf-8').catch(() => '');
      if (unchanged === rawExisting) {
        await fs.rm(filePath, { force: true });
        continue;
      }
      // Someone rewrote the lock between read and remove — treat as live.
    }
    // Different host (shared folder), a live/uncertain PID, or an unreadable
    // lock: do NOT auto-reclaim (§8.6).
    return {
      error: `Another ccxlog run holds the lock at ${filePath}`
        + (existing ? ` (host ${existing.host}, pid ${existing.pid}).` : '.')
        + (existing && !sameHost ? ' It is on a different host; not auto-reclaiming.' : '')
        + ' Re-run with --force-unlock to remove it manually.',
    };
  }
  return { error: `Could not acquire lock at ${filePath}` };
}

export async function releaseLock(handle: LockHandle): Promise<void> {
  try {
    const info = JSON.parse(await fs.readFile(handle.filePath, 'utf-8')) as LockInfo;
    if (info.token === handle.token) {
      await fs.rm(handle.filePath, { force: true });
    }
  } catch {
    // Lock already gone or unreadable — nothing to release.
  }
}
