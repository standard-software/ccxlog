import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sha256HexBytes } from './pathUtils.js';
import { decodeSid64 } from './identity.js';
import type { CcxlogConfig } from './config.js';
import type { Source } from './types.js';

export const BACKUP_JSONL_DIR = 'backup_jsonl';
export const BACKUP_MD_DIR = 'backup_CCXLOG_md';

export function backupHostName(): string {
  let raw = '';
  try { raw = os.hostname(); } catch { raw = ''; }
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'unknown-host';
}

export function backupFolderName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_`
    + `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return `${stamp}_${backupHostName()}`;
}

export interface JsonlBackupItem {
  filePath: string;
  source: Source;
  baseName: string;   // display name inside the backup
}

// Copy discovered source JSONL into backup_jsonl/<stamp>/<cc|cx>/ unchanged.
// Returns count. Throws on the first copy failure after reporting.
export async function backupJsonlFiles(
  items: JsonlBackupItem[],
  outDir: string,
  folder: string,
  verbose: boolean,
): Promise<number> {
  const root = path.join(outDir, BACKUP_JSONL_DIR, folder);
  const used = new Map<string, Set<string>>();
  let copied = 0;
  for (const it of items) {
    const sub = it.source === 'claude' ? 'cc' : 'cx';
    const destDir = path.join(root, sub);
    await fs.mkdir(destDir, { recursive: true });
    if (!used.has(sub)) used.set(sub, new Set());
    const seen = used.get(sub)!;
    let name = `${it.baseName}.jsonl`;
    if (seen.has(name)) {
      name = `${it.baseName}__${sha256HexBytes(it.filePath, 8)}.jsonl`;
    }
    seen.add(name);
    const dest = path.join(destDir, name);
    if (await exists(dest)) { continue; } // never overwrite existing backup
    await fs.copyFile(it.filePath, dest);
    copied++;
    if (verbose) console.log(`  backup: ${it.filePath} -> ${sub}/${name}`);
  }
  return copied;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function readHead(filePath: string, bytes = 512): Promise<string> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    await handle?.close();
  }
}

const AGG_OWNER_HEAD = /<!-- ccxlog-owner:ccxlog; kind:aggregate; mode:(both|claude|codex) -->/;
const SESSION_OWNER_HEAD = /^<!-- ccxlog-owner:ccxlog; kind:session; source:(claude|codex); sid64:([A-Za-z0-9_-]+) -->$/m;
const LEGACY_AGG_HEAD = /(^|\n)# (ccxlog|cclog|cxlog)\s*(\n|$)/;
const LEGACY_SESSION_HEAD = /(^|\n)# (CCXLog|CCLog|CXLog):/;

export interface SessionMarker {
  source: Source;
  sessionId: string;
}

// Parse the strict kind:session marker from a file head (§8.4). Returns null
// on malformed marker or undecodable sid64 (treated as "not parseable" — the
// file is never deleted).
export async function parseSessionMarker(filePath: string): Promise<SessionMarker | null> {
  const head = await readHead(filePath, 512);
  const m = SESSION_OWNER_HEAD.exec(head);
  if (!m) return null;
  const sessionId = decodeSid64(m[2]);
  if (sessionId === null) return null;
  return { source: m[1] as Source, sessionId };
}

// Which exported .md files in outDir --backup-md should copy (§9.4).
export async function listExportedMdFiles(outDir: string, cfg: CcxlogConfig): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(outDir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const aggNames = new Set([cfg.outputAllFileName, cfg.claude.outputAllFileName, cfg.codex.outputAllFileName]);
  const prefixes = [cfg.claude.outputSessionFilePrefix, cfg.codex.outputSessionFilePrefix].filter(p => p !== '');
  const picked = new Set<string>();
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(outDir, name);
    let st;
    try { st = await fs.stat(full); } catch { continue; }
    if (!st.isFile()) continue;
    const head = await readHead(full, 512);

    if (aggNames.has(name) && (AGG_OWNER_HEAD.test(head) || LEGACY_AGG_HEAD.test(head))) {
      picked.add(full);
      continue;
    }
    if (SESSION_OWNER_HEAD.test(head)) {
      picked.add(full);
      continue;
    }
    if (prefixes.some(p => name.startsWith(p)) && LEGACY_SESSION_HEAD.test(head)) {
      picked.add(full);
      continue;
    }
  }
  return Array.from(picked).sort();
}

export async function backupMdFiles(
  mdFiles: string[],
  outDir: string,
  folder: string,
  verbose: boolean,
): Promise<number> {
  const destDir = path.join(outDir, BACKUP_MD_DIR, folder);
  await fs.mkdir(destDir, { recursive: true });
  let copied = 0;
  for (const f of mdFiles) {
    await fs.copyFile(f, path.join(destDir, path.basename(f)));
    copied++;
    if (verbose) console.log(`  backup: ${f} -> ${path.basename(f)}`);
  }
  return copied;
}
