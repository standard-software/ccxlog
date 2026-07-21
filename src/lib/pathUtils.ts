import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function sha256HexBytes(input: string | Buffer, digits: number): string {
  return sha256Hex(input).slice(0, digits);
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
export interface FileIdentity {
  key: string;
  size: number;
  mtimeMs: number;
}

export async function fileIdentity(filePath: string): Promise<FileIdentity | null> {
  try {
    const st = await fs.stat(filePath);
    const key = st.ino !== 0 ? `dev:${st.dev}:ino:${st.ino}` : canonicalPathString(filePath);
    return { key, size: st.size, mtimeMs: st.mtimeMs };
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
