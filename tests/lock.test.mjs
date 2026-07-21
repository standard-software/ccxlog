// §8.6 advisory lock (opt-in). New-develop API: acquireLock(outDir, forceUnlock)
// -> { handle?, error? } and releaseLock(handle). Conservative reclaim: a
// same-host dead-PID lock is auto-reclaimed; a different-host lock is not
// (only --force-unlock removes it). Ported/adapted from old-develop unit-lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, releaseLock } from '../dist/lib/lock.js';
import { mkTmp, rmrf } from './helpers.mjs';

const LOCK_FILE = '.ccxlog.lock';

function tmpOut(t) {
  const dir = mkTmp('ccx-lock-');
  if (t) t.after(() => rmrf(dir));
  return dir;
}

function validToken() {
  return 'a'.repeat(24); // matches the /^[0-9a-f]{24}$/ shape looksValid requires
}

test('a live lock is respected without --force-unlock; release lets re-acquire succeed', async t => {
  const out = tmpOut(t);
  const first = await acquireLock(out, false);
  assert.ok(first.handle, 'first acquisition succeeds');

  const second = await acquireLock(out, false);
  assert.ok(second.error, 'a live lock blocks a second acquisition');
  assert.ok(!second.handle);

  await releaseLock(first.handle);
  // After release the lock file is gone and re-acquire succeeds.
  assert.equal(fs.existsSync(path.join(out, LOCK_FILE)), false);
  const third = await acquireLock(out, false);
  assert.ok(third.handle);
  await releaseLock(third.handle);
});

test('a same-host dead-PID lock is auto-reclaimed (§8.6 明白に安全)', async t => {
  const out = tmpOut(t);
  const stale = {
    host: os.hostname(),
    pid: 999999999,            // not a live process on this host
    token: validToken(),
    acquiredAt: new Date().toISOString(),
    startedAt: new Date(0).toISOString(),
  };
  fs.writeFileSync(path.join(out, LOCK_FILE), JSON.stringify(stale) + '\n');
  const r = await acquireLock(out, false);
  assert.ok(r.handle, 'a well-formed same-host dead-PID lock is safely reclaimed');
  await releaseLock(r.handle);
});

test('a different-host lock is NOT auto-reclaimed without --force-unlock', async t => {
  const out = tmpOut(t);
  const foreign = {
    host: os.hostname() + '-OTHER',
    pid: 999999999,
    token: validToken(),
    acquiredAt: new Date().toISOString(),
    startedAt: new Date(0).toISOString(),
  };
  fs.writeFileSync(path.join(out, LOCK_FILE), JSON.stringify(foreign) + '\n');
  const r = await acquireLock(out, false);
  assert.ok(r.error, 'a foreign-host lock is conservatively respected');
  assert.match(r.error, /different host|holds the lock/i);
});

test('--force-unlock reclaims any lock, including a foreign-host one', async t => {
  const out = tmpOut(t);
  const foreign = {
    host: os.hostname() + '-OTHER',
    pid: process.pid,
    token: validToken(),
    acquiredAt: new Date().toISOString(),
    startedAt: new Date(0).toISOString(),
  };
  fs.writeFileSync(path.join(out, LOCK_FILE), JSON.stringify(foreign) + '\n');
  const r = await acquireLock(out, true);   // force reclaim
  assert.ok(r.handle, 'force-unlock removes the foreign lock and acquires');
  await releaseLock(r.handle);
});
