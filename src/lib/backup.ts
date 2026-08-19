import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sha256HexBytes } from './pathUtils.js';
import { decodeSid64 } from './identity.js';
import { ALL_AGGREGATE_FILE_NAMES, SESSION_FILE_PREFIX } from './outputNames.js';
import type { Source } from './types.js';

export const BACKUP_JSONL_DIR = 'backup_jsonl';
export const BACKUP_MD_DIR = 'backup_CCXLOG_md';
// Automatic backups (the copy taken just before a rewrite where id loss was
// detected) go to a folder separate from the manual --backup-md one (v1.5.0), so
// that "something new appeared in _auto = a signal that pairs were about to
// disappear" is not buried in the pile of manual backups.
export const BACKUP_MD_AUTO_DIR = 'backup_CCXLOG_md_auto';

// Written beside the copies inside an automatic backup folder. An automatic
// backup only ever appears because something was about to be lost, and the
// folder alone says nothing about WHAT or WHY — answering that used to mean
// diffing the copy against the live file by hand and hunting for the session
// whose log had gone. This file records it at the moment the backup is taken,
// which is the only moment the old content is still available.
export const BACKUP_REASON_FILE = 'ccxlog-backup-reason.txt';

export type BackupReason =
  // A rewrite that drops blocks: exactly which ids, and how they read.
  | { kind: 'ids-lost'; oldCount: number; newCount: number; lost: Array<{ id: string; label: string }> }
  // The two sides could not be compared, so the backup was taken on the safe
  // side; `detail` says which side could not be read and why.
  | { kind: 'undecidable'; oldCount: number; newCount: number; detail: string }
  // A per-session output file about to be removed (equivalent to losing every
  // block it holds).
  | { kind: 'file-deleted' };

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

function timestampText(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} `
    + `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

const REASON_HEADER = [
  'ccxlog automatic backup',
  '=======================',
  '',
  'The copies in this folder are the versions from BEFORE a run that was about',
  'to remove conversation blocks from them. ccxlog takes this backup by itself,',
  'so a folder here always means something was about to be lost.',
  '',
  'A block disappears when the source JSONL it was rendered from can no longer',
  'be read - deleted by the logging tool\'s own retention, a log directory that',
  'is not mounted at the moment, a moved project path - or when an upgrade to',
  'ccxlog changes how blocks are formed. The first kind is worth acting on: the',
  'content below now exists only in this folder.',
  '',
  '',
].join('\n');

// The lost-block list is capped: a first run after an upgrade can reshape
// hundreds of blocks at once, and a reason file longer than the backup it
// explains helps nobody. The count above the list is never capped, so a
// truncated list still reports the true scale.
const MAX_LISTED_BLOCKS = 200;

export function renderBackupReason(
  filePath: string,
  reason: BackupReason,
  version: string,
  now: Date,
): string {
  const lines = [
    '----------------------------------------------------------------------',
    `File           : ${filePath}`,
    `Backed up at   : ${timestampText(now)}`,
    `ccxlog version : ${version}`,
  ];
  if (reason.kind === 'file-deleted') {
    lines.push(
      'Reason         : the output file itself is being removed, because the',
      '                 session it belongs to no longer produces any block.',
    );
  } else if (reason.kind === 'undecidable') {
    lines.push(
      `Reason         : the old and new content could not be compared, so the`,
      `                 backup was taken on the safe side - ${reason.detail}.`,
      `Blocks         : ${reason.oldCount} before -> ${reason.newCount} after`,
    );
  } else {
    lines.push(
      `Reason         : ${reason.lost.length} block(s) present before the rewrite are missing`,
      '                 from the new content.',
      `Blocks         : ${reason.oldCount} before -> ${reason.newCount} after`,
      '',
      'Lost blocks (ccxlogid, then the first line of the block):',
    );
    for (const b of reason.lost.slice(0, MAX_LISTED_BLOCKS)) {
      lines.push(`  ${b.id}`, `    ${b.label || '(no content after the marker)'}`);
    }
    if (reason.lost.length > MAX_LISTED_BLOCKS) {
      lines.push(`  ... and ${reason.lost.length - MAX_LISTED_BLOCKS} more (see the backed up file itself)`);
    }
  }
  lines.push('', '');
  return lines.join('\n');
}

// Append one section per backed-up file, writing the shared header the first
// time. Best effort by design: the reason is an explanation of a backup that
// has already been taken and verified, so failing to record it must never turn
// a successful backup into a failed run.
export async function appendBackupReason(
  backupDir: string,
  filePath: string,
  reason: BackupReason,
  version: string,
  now: Date,
): Promise<void> {
  try {
    const dest = path.join(backupDir, BACKUP_REASON_FILE);
    const head = (await exists(dest)) ? '' : REASON_HEADER;
    await fs.appendFile(dest, head + renderBackupReason(filePath, reason, version, now), 'utf-8');
  } catch { /* explanation only — never fail the run over it */ }
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
export async function listExportedMdFiles(outDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(outDir);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const aggNames = new Set(ALL_AGGREGATE_FILE_NAMES);
  const prefixes = Object.values(SESSION_FILE_PREFIX);
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
