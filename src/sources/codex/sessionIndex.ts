import fs from 'node:fs/promises';
import path from 'node:path';
import { forEachLine } from '../../lib/lineStream.js';
import { canonicalPathString, isPathWithin } from '../../lib/pathUtils.js';
import type { RootRef, SessionData } from '../adapter.js';

interface SessionIndexEntry {
  id?: unknown;
  thread_name?: unknown;
  updated_at?: unknown;
}

// One recorded name plus how fresh it is. `at` is the record's own timestamp
// (epoch ms) when Codex wrote one; `seq` is the position in the file, used
// whenever a timestamp is missing on either side of a comparison.
interface NameRecord {
  name: string;   // '' means the name was cleared
  at: number | null;
  seq: number;
}

function isFresher(candidate: NameRecord, current: NameRecord): boolean {
  if (candidate.at !== null && current.at !== null && candidate.at !== current.at) {
    return candidate.at > current.at;
  }
  return candidate.seq >= current.seq;
}

async function readSessionIndexRecords(filePath: string): Promise<Map<string, NameRecord>> {
  const records = new Map<string, NameRecord>();
  let seq = 0;
  try {
    await forEachLine(filePath, (line) => {
      if (!line.trim()) return;
      let entry: SessionIndexEntry;
      try { entry = JSON.parse(line) as SessionIndexEntry; } catch { return; }
      if (typeof entry.id !== 'string' || !entry.id) return;
      if (!Object.prototype.hasOwnProperty.call(entry, 'thread_name')) return;
      seq += 1;
      // The file is append-only, but a rename carries its own `updated_at`, so
      // order by that when both records have one and fall back to file order.
      const parsed = typeof entry.updated_at === 'string' ? Date.parse(entry.updated_at) : NaN;
      const at = Number.isFinite(parsed) ? parsed : null;
      const name = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : '';
      const record: NameRecord = { name, at, seq };
      const current = records.get(entry.id);
      if (current && !isFresher(record, current)) return;
      records.set(entry.id, record);
    });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  return records;
}

/** id -> thread name from one `session_index.jsonl` (cleared names are dropped). */
export async function readSessionIndex(filePath: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const [id, record] of await readSessionIndexRecords(filePath)) {
    if (record.name) names.set(id, record.name);
  }
  return names;
}

// ---- Codex's live store: <codex home>/state_<n>.sqlite -----------------------

const STATE_DB_RE = /^state_(\d+)\.sqlite$/;

interface SqliteRow { id?: unknown; name?: unknown; title?: unknown }
interface SqliteStatement { all(): unknown[] }
interface SqliteDatabase { prepare(sql: string): SqliteStatement; close(): void }
type SqliteModule = { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDatabase };

// `node:sqlite` only exists from Node 22. Resolve it through a variable so the
// build does not depend on its type declarations, and remember the failure so
// an older runtime pays the lookup once.
let sqliteModule: SqliteModule | null | undefined;
async function loadSqlite(): Promise<SqliteModule | null> {
  if (sqliteModule !== undefined) return sqliteModule;
  const specifier = 'node:sqlite';
  try {
    sqliteModule = await import(specifier) as SqliteModule;
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

async function findStateDb(codexHome: string): Promise<string | null> {
  let best: { file: string; version: number } | null = null;
  try {
    for (const name of await fs.readdir(codexHome)) {
      const match = STATE_DB_RE.exec(name);
      if (!match) continue;
      const version = Number(match[1]);
      if (!best || version > best.version) best = { file: path.join(codexHome, name), version };
    }
  } catch {
    return null;
  }
  return best?.file ?? null;
}

/**
 * id -> thread name from Codex's `threads` table. This is the name Codex itself
 * shows: a rename lands here immediately, while `session_index.jsonl` is an
 * append-only log that can still hold a stale record for the same session.
 * Any failure (Node without `node:sqlite`, a locked or older database) simply
 * yields no names so the index file stays in charge.
 */
export async function readStateDbNames(codexHome: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const file = await findStateDb(codexHome);
  if (!file) return names;
  const sqlite = await loadSqlite();
  if (!sqlite) return names;
  let db: SqliteDatabase | null = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    for (const row of db.prepare('SELECT id, name, title FROM threads').all() as SqliteRow[]) {
      if (typeof row.id !== 'string' || !row.id) continue;
      const named = typeof row.name === 'string' ? row.name.trim() : '';
      const titled = typeof row.title === 'string' ? row.title.trim() : '';
      const name = named || titled;
      if (name) names.set(row.id, name);
    }
  } catch {
    return new Map();
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
  return names;
}

// ---- resolution --------------------------------------------------------------

function indexCandidates(root: RootRef): string[] {
  const parentIndex = path.join(path.dirname(root.dir), 'session_index.jsonl');
  if (root.origin === 'standard') return [parentIndex];
  return [path.join(root.dir, 'session_index.jsonl'), parentIndex];
}

// A standard root is `<codex home>/sessions`; a copied extra root may itself be
// the home that holds the database.
function stateDbHomes(root: RootRef): string[] {
  const parent = path.dirname(root.dir);
  return root.origin === 'standard' ? [parent] : [root.dir, parent];
}

interface IndexedRoot {
  rootDir: string;
  indexNames: Map<string, NameRecord>;
  dbNames: Map<string, string>;
}

async function loadIndexedRoot(root: RootRef): Promise<IndexedRoot> {
  const indexNames = new Map<string, NameRecord>();
  const seen = new Set<string>();
  for (const candidate of indexCandidates(root)) {
    const key = canonicalPathString(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    // Merge on freshness, not on file order: a co-located index that was copied
    // along with the rollouts must not outrank a newer rename in the live one.
    for (const [id, record] of await readSessionIndexRecords(candidate)) {
      const current = indexNames.get(id);
      if (current && !isFresher(record, current)) continue;
      indexNames.set(id, record);
    }
  }
  let dbNames = new Map<string, string>();
  for (const home of stateDbHomes(root)) {
    dbNames = await readStateDbNames(home);
    if (dbNames.size > 0) break;
  }
  return { rootDir: canonicalPathString(root.dir), indexNames, dbNames };
}

export async function applyCodexSessionNames(
  sessions: SessionData[],
  roots: RootRef[],
): Promise<SessionData[]> {
  const indexedRoots = await Promise.all(roots.map(loadIndexedRoot));
  // A nested extra root may overlap another configured root. Select the most
  // specific matching root so its own session index owns the rollout.
  indexedRoots.sort((a, b) => b.rootDir.length - a.rootDir.length);

  return sessions.map((session) => {
    const filePath = canonicalPathString(session.jsonlPath);
    for (const indexed of indexedRoots) {
      if (!isPathWithin(filePath, indexed.rootDir)) continue;
      const record = indexed.indexNames.get(session.sessionId);
      const name = indexed.dbNames.get(session.sessionId) ?? (record?.name || '');
      // Nothing named this session here: keep looking in the broader roots
      // instead of giving up on the first one that merely contains the file.
      if (!name) continue;
      if (name === session.sessionName) return session;
      return { ...session, sessionName: name };
    }
    return session;
  });
}
