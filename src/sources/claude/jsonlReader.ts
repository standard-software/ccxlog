import fs from 'node:fs/promises';
import { forEachLine } from '../../lib/lineStream.js';
import { lazyFileSha256 } from '../../lib/pathUtils.js';
import type { LogEntry } from '../../lib/types.js';

export interface ClaudeReadResult {
  entries: LogEntry[];
  skippedLines: number;
  fileSize: number;
  fileContentHash: () => Promise<string>;   // lazy + memoised (§6.3 complete-copy check)
  eventIdStream: string[];
  formatRecognized: boolean;   // was at least one Claude-format entry seen? (§format detection, v1.5.0)
}

// Read a Claude Code JSONL file. Broken lines are counted and skipped, and the
// rest are kept. The event-id stream used for logical de-duplication (§6.3) is
// collected as raw "type\0id" strings — strictPrefix compares elements for
// equality, so raw strings discriminate exactly as well as the old per-element
// SHA-256 while avoiding a cryptographic hash per log line. The whole-file hash
// is lazy (see lazyFileSha256 in pathUtils; it is handed the pre-read snapshot
// of size/mtime/dev/ino so a file modified or replaced after analysis is never
// used to confirm a duplicate).
export async function readJsonl(filePath: string): Promise<ClaudeReadResult> {
  const stat = await fs.stat(filePath);
  const entries: LogEntry[] = [];
  const eventIdStream: string[] = [];
  let skipped = 0;
  // What makes a file recognisable as a Claude session log: at least one user or
  // assistant entry carrying a message. A file with none (a Codex rollout, or an
  // unrelated jsonl) is left out as a source mismatch (§format detection, v1.5.0).
  let formatRecognized = false;
  await forEachLine(filePath, (line) => {
    if (!line.trim()) return;
    try {
      const entry = JSON.parse(line) as LogEntry;
      entries.push(entry);
      if ((entry.type === 'user' || entry.type === 'assistant')
        && (entry as { message?: unknown }).message) formatRecognized = true;
      const uuid = (entry as { uuid?: unknown }).uuid;
      const id = typeof uuid === 'string' ? uuid : '';
      eventIdStream.push(`${entry.type}\0${id}`);
    } catch {
      skipped++;
    }
  });
  return {
    entries,
    skippedLines: skipped,
    fileSize: stat.size,
    fileContentHash: lazyFileSha256(filePath, {
      size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino,
    }),
    eventIdStream,
    formatRecognized,
  };
}
