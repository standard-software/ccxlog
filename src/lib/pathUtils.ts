import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function sha256HexBytes(input: string | Buffer, digits: number): string {
  return sha256Hex(input).slice(0, digits);
}

// A file's state at analysis time, used by the lazy hash and by the prefilter to
// check "is this still the same, unchanged file?". It carries dev/ino as well as
// size/mtime: size and mtime alone cannot detect a replacement by a
// different-content file of the same size with its mtime preserved (a `cp -p`
// style rename replacement, or a same-size rewrite on a filesystem with coarse
// mtime granularity). That would let a hash of content OTHER than what was
// analysed confirm a duplicate and delete a legitimate pair — the one remaining
// path that failed toward LOSING data. Including dev/ino detects that the
// underlying object changed across a rename replacement (on filesystems without
// inode numbers the comparison is 0 against 0, degrading naturally to
// size/mtime only).
// Known limit (theoretical): an in-place edit that keeps the same inode and
// size and restores the original mtime is invisible to this four-attribute
// check. Closing it entirely would mean re-reading a content fingerprint (a
// partial hash, say) on every comparison, which would break the premise this
// speedup rests on — never read a file outside the rarely-taken paths. Ordinary
// log writing (appending) does not produce such an edit; producing one takes
// deliberate external mtime restoration. Design decision, also recorded in
// SPEEDUP-NOTES §7.
export interface FileSnapshot {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export async function fileSnapshot(filePath: string): Promise<FileSnapshot | null> {
  try {
    const st = await fs.stat(filePath);
    return { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

export function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.dev === b.dev && a.ino === b.ino;
}

// Stream chunk size for the lazy hash. R1 demonstrated that the 64KB default is
// slow, so the hash path states a larger chunk explicitly too — it fires rarely,
// but leaving it inconsistent with what we learned about the read path would be
// a trap.
export const HASH_READ_CHUNK_BYTES = 1024 * 1024;

// Lazy, memoised whole-file SHA-256, for the §6.3 duplicate check's "is this a
// complete copy of the file?" question. The hash is needed only for pairs whose
// candidate keys matched AND that the cheap checks failed to settle — in
// practice almost never — so it is not computed on the normal read path (the old
// implementation hashed every log byte while reading, every time).
// - It is computed by async streaming. A readFileSync slurp would put the whole
//   file in memory (against the §12.3 design rule at the 350MB scale) and stall
//   the event loop, so it is not used.
// - TOCTOU protection: the snapshot taken at analysis time (size/mtime/dev/ino)
//   is compared against a stat immediately before and after hashing. A file
//   modified or replaced after analysis — including an append during hashing —
//   returns '', i.e. "not confirmed as a duplicate". That is the same
//   conservative behaviour as having no hash at all, and fails toward keeping
//   both copies.
// - An unreadable file likewise returns '' (not confirmed as a duplicate).
export function lazyFileSha256(filePath: string, expected: FileSnapshot): () => Promise<string> {
  let memo: Promise<string> | null = null;
  return () => (memo ??= hashFileGuarded(filePath, expected));
}

async function hashFileGuarded(filePath: string, expected: FileSnapshot): Promise<string> {
  try {
    const before = await fileSnapshot(filePath);
    if (!before || !sameSnapshot(before, expected)) return '';
    const hash = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { highWaterMark: HASH_READ_CHUNK_BYTES });
      stream.on('data', (chunk: string | Buffer) => {
        hash.update(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const after = await fileSnapshot(filePath);
    if (!after || !sameSnapshot(after, expected)) return '';
    return hash.digest('hex');
  } catch {
    return '';
  }
}

// Claude Code's project-directory encoding: EVERY character outside
// [a-zA-Z0-9] becomes '-' (not just path separators). '_' '.' spaces and
// non-ASCII all collapse to '-'.
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

export function getClaudeLogDirForProject(cwd: string): string {
  return path.join(getClaudeProjectsDir(), encodeCwd(cwd));
}

export function getCodexSessionsDir(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

// canonicalPath (§5.4): resolve -> realpath (best effort) -> normalize ->
// win32-only lowercase. Cached because the same cwds repeat across pairs.
const canonicalCache = new Map<string, string>();
export async function canonicalPath(p: string): Promise<string> {
  const key = path.resolve(p);
  const hit = canonicalCache.get(key);
  if (hit !== undefined) return hit;
  let real: string;
  try {
    real = await fs.realpath(key);
  } catch {
    real = key;
  }
  let canon = path.normalize(real);
  if (process.platform === 'win32') canon = canon.toLowerCase();
  canonicalCache.set(key, canon);
  return canon;
}

// Drop the memo at a watch cycle boundary. For a single run ("one process = one
// run") the memo's lifetime equals the run, which was harmless; under watch, a
// realpath resolution would otherwise be frozen for the process's lifetime and
// two things would stop taking effect no matter how many cycles pass:
//   - a path that did not exist at resolution time (where the catch above
//     accepted the resolve() result as final) later gaining a real target
//   - a symlink / junction being re-pointed
// Both are situations where belonging (filterSession / the cwd prefilter) SHOULD
// change without any config change, and they are a miss path independent of the
// incremental re-parse cache. realpath is called at most once per distinct
// target cwd per cycle, so the cost is small: drop the memo at the start of each
// cycle and resolve afresh.
export function clearCanonicalPathCache(): void {
  canonicalCache.clear();
}

// The external path resolution an "excluded" outcome depended on (for the
// incremental re-parse cache). `raw` is the raw path string the decision used (a
// cwd inside a Codex log, say) and `canon` is what canonicalPath() returned that
// cycle. Even with a file's four attributes unchanged, re-pointing a symlink /
// junction along `raw` changes `canon` — and can change the outcome. Exclusion
// outcomes hold no raw data and cannot be rescued later, so this dependency is
// carried explicitly and verified every cycle.
export interface PathDep {
  raw: string;
  canon: string;
}

// Check that a recorded resolution still holds. canonicalPath() is memoised
// within a cycle and the memo is dropped at the start of each one, so the real
// realpath calls stay at "once per distinct raw per cycle".
// An unresolvable path makes canonicalPath() return the resolve() result, so a
// vanished link also shows up as a mismatched canon — meaning re-scan, the safe
// direction.
export async function pathDepsUnchanged(deps: readonly PathDep[]): Promise<boolean> {
  for (const d of deps) {
    if (await canonicalPath(d.raw) !== d.canon) return false;
  }
  return true;
}

// String canonicalization without touching the filesystem (for non-existent
// paths / stableRootKey). resolve -> normalize -> win32 lowercase.
export function canonicalPathString(p: string): string {
  let canon = path.normalize(path.resolve(p));
  if (process.platform === 'win32') canon = canon.toLowerCase();
  return canon;
}

export function isPathWithin(filePath: string, rootPath: string): boolean {
  if (filePath === rootPath) return true;
  const prefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  return filePath.startsWith(prefix);
}

// Physical-file identity key: dev+ino when available, else canonical path.
// `snapshot` holds the four attributes derived from that same stat and feeds the
// identity check of the incremental re-parse cache (lib/analysisCache.ts).
// Because it is taken at discovery time — before reading — a file that changes
// during or after the read is guaranteed to surface as a mismatch next cycle,
// i.e. it fails toward re-reading, the safe direction.
export interface FileIdentity {
  key: string;
  snapshot: FileSnapshot;
}

export async function fileIdentity(filePath: string): Promise<FileIdentity | null> {
  try {
    const st = await fs.stat(filePath);
    const key = st.ino !== 0 ? `dev:${st.dev}:ino:${st.ino}` : canonicalPathString(filePath);
    return { key, snapshot: { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino } };
  } catch {
    return null;
  }
}

// Namespaced sourceFileRelativeId (§5.5):
//   <source>/<standard|extra>/<stableRootKey>/<relativePath>
export function buildRelativeId(
  source: 'claude' | 'codex',
  origin: 'standard' | 'extra',
  stableRootKey: string,
  rootDir: string,
  filePath: string,
): string {
  const rel = path.relative(rootDir, filePath).split(path.sep).join('/');
  return `${source}/${origin}/${stableRootKey}/${rel}`;
}
