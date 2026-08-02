import path from 'node:path';
import { forEachLine } from '../../lib/lineStream.js';
import { canonicalPathString, isPathWithin } from '../../lib/pathUtils.js';
import type { RootRef, SessionData } from '../adapter.js';

interface SessionIndexEntry {
  id?: unknown;
  thread_name?: unknown;
}

export async function readSessionIndex(filePath: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    await forEachLine(filePath, (line) => {
      if (!line.trim()) return;
      let entry: SessionIndexEntry;
      try { entry = JSON.parse(line) as SessionIndexEntry; } catch { return; }
      if (typeof entry.id !== 'string' || !entry.id) return;
      if (!Object.prototype.hasOwnProperty.call(entry, 'thread_name')) return;
      if (typeof entry.thread_name !== 'string' || !entry.thread_name.trim()) {
        names.delete(entry.id);
        return;
      }
      names.set(entry.id, entry.thread_name.trim());
    });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  return names;
}

function indexCandidates(root: RootRef): string[] {
  const parentIndex = path.join(path.dirname(root.dir), 'session_index.jsonl');
  if (root.origin === 'standard') return [parentIndex];
  return [path.join(root.dir, 'session_index.jsonl'), parentIndex];
}

interface IndexedRoot {
  rootDir: string;
  names: Map<string, string>;
}

async function loadIndexedRoot(root: RootRef): Promise<IndexedRoot> {
  const names = new Map<string, string>();
  const seen = new Set<string>();
  for (const candidate of indexCandidates(root)) {
    const key = canonicalPathString(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    // More specific locations win: for an extra root, a co-located index is
    // read before the parent index and therefore keeps precedence.
    const fromFile = await readSessionIndex(candidate);
    for (const [id, name] of fromFile) {
      if (!names.has(id)) names.set(id, name);
    }
  }
  return { rootDir: canonicalPathString(root.dir), names };
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
      const name = indexed.names.get(session.sessionId);
      if (!name || name === session.sessionName) return session;
      return { ...session, sessionName: name };
    }
    return session;
  });
}
