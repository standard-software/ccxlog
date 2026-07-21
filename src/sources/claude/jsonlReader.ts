import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { forEachLine } from '../../lib/lineStream.js';
import type { LogEntry } from '../../lib/types.js';

export interface ClaudeReadResult {
  entries: LogEntry[];
  skippedLines: number;
  fileSize: number;
  fileContentHash: string;
  eventIdStreamHash: string[];
}

// Read a Claude Code JSONL file. Malformed lines are counted and skipped; the
// rest of the file is preserved. Also computes the whole-file SHA-256 and the
// stable event-id stream (used by logical de-duplication, §6.3).
export async function readJsonl(filePath: string): Promise<ClaudeReadResult> {
  const stat = await fs.stat(filePath);
  const entries: LogEntry[] = [];
  const eventIdStreamHash: string[] = [];
  let skipped = 0;
  const fileContentHash = await forEachLine(filePath, (line) => {
    if (!line.trim()) return;
    try {
      const entry = JSON.parse(line) as LogEntry;
      entries.push(entry);
      const uuid = (entry as { uuid?: unknown }).uuid;
      const id = typeof uuid === 'string' ? uuid : '';
      eventIdStreamHash.push(crypto.createHash('sha256').update(`${entry.type}\0${id}`).digest('hex').slice(0, 16));
    } catch {
      skipped++;
    }
  });
  return { entries, skippedLines: skipped, fileSize: stat.size, fileContentHash, eventIdStreamHash };
}
