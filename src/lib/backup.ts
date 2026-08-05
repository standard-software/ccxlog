import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sha256HexBytes } from './pathUtils.js';
import { decodeSid64 } from './identity.js';
import type { CcxlogConfig } from './config.js';
import type { Source } from './types.js';

export const BACKUP_JSONL_DIR = 'backup_jsonl';
export const BACKUP_MD_DIR = 'backup_CCXLOG_md';
// Automatic backups (the copy taken just before a rewrite where id loss was
// detected) go to a folder separate from the manual --backup-md one (v1.5.0), so
// that "something new appeared in _auto = a signal that pairs were about to
// disappear" is not buried in the pile of manual backups.
export const BACKUP_MD_AUTO_DIR = 'backup_CCXLOG_md_auto';

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
  relPath: string;    // path relative to the discovery root (structure is preserved in the backup)
}

// Copy discovered source JSONL into backup_jsonl/<stamp>/<cc|cx>/ unchanged,
// preserving each file's root-relative path (v1.5.0):
//   cc/<session id>.jsonl and cc/<session id>/subagents/agent-*.jsonl
//   (a mirror of the live log layout, so pointing extraLogDirs at cc/ behaves
//   exactly like the live tree)
//   cx/<year>/<month>/<day>/rollout-*.jsonl (the date tree is preserved; a codex
//   extra root is scanned recursively)
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
    if (!used.has(sub)) used.set(sub, new Set());
    const seen = used.get(sub)!;
    // When files from different roots collide on their relative path, fall back
    // to a hashed name so neither overwrites the other.
    let rel = it.relPath;
    if (seen.has(rel)) {
      rel = rel.replace(/\.jsonl$/, `__${sha256HexBytes(it.filePath, 8)}.jsonl`);
    }
    seen.add(rel);
    const dest = path.join(root, sub, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (await exists(dest)) { continue; } // never overwrite existing backup
    await fs.copyFile(it.filePath, dest);
    copied++;
    if (verbose) console.log(`  backup: ${it.filePath} -> ${sub}/${rel.replace(/\\/g, '/')}`);
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
  /**
   * The log this file was generated FROM, as recorded by the "- Source: <path>"
   * line of the per-session preamble (markdownWriter.buildSessionPreamble), or
   * '' when the line is absent — a file written by a version that predates it,
   * or truncated beyond the head we read.
   *
   * The session id alone cannot say WHICH session wrote a file, because a Codex
   * subagent used to be filed under its parent's id: `cxlog_<parent>.md` with
   * marker `codex:<parent>` is produced both by the parent's own run and by a
   * child writing under the old naming. The recorded log path is the only thing
   * in the file that tells the two apart.
   */
  sourcePath: string;
}

// The generated line is `- Source: <absolute path to the .jsonl>`. Anchored to
// a line start so a path appearing inside a question can never be mistaken for
// it; the preamble is the only place it occurs within the head anyway.
const SESSION_SOURCE_HEAD = /^- Source: (.+)$/m;

// Parse the strict kind:session marker from a file head (§8.4). Returns null
// on malformed marker or undecodable sid64 (treated as "not parseable" — the
// file is never deleted).
//
// 4 KiB rather than the 512 bytes the marker itself needs: the "- Source:"
// line sits below the owner line, the notice, the heading and the project
// path, and every one of those grows with the length of a user's paths. A head
// too short to reach it would silently read as "no recorded source", which is
// the direction that refuses to delete — safe, but it would make the check
// useless on exactly the deep paths it matters for.
export async function parseSessionMarker(filePath: string): Promise<SessionMarker | null> {
  const head = await readHead(filePath, 4096);
  const m = SESSION_OWNER_HEAD.exec(head);
  if (!m) return null;
  const sessionId = decodeSid64(m[2]);
  if (sessionId === null) return null;
  return { source: m[1] as Source, sessionId, sourcePath: SESSION_SOURCE_HEAD.exec(head)?.[1].trim() ?? '' };
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
