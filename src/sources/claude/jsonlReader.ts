import fs from 'node:fs/promises';
import { forEachLine } from '../../lib/lineStream.js';
import { lazyFileSha256 } from '../../lib/pathUtils.js';
import type { LogEntry } from '../../lib/types.js';

export interface ClaudeReadResult {
  entries: LogEntry[];
  skippedLines: number;
  fileSize: number;
  fileContentHash: () => Promise<string>;   // 遅延・メモ化（§6.3 完全コピー確認用）
  eventIdStream: string[];
}

// Claude Code の JSONL ファイルを読む。壊れた行はカウントしてスキップし、
// 残りは保持する。論理重複排除（§6.3）用のイベントID列は生の "type\0id"
// 文字列として収集する — strictPrefix は要素等価比較なので、生文字列は
// 旧実装の要素毎 SHA-256 と全く同じ判別力を持ち、ログ1行毎の暗号学的
// ハッシュ代を払わずに済む。全ファイルハッシュは遅延化した（pathUtils の
// lazyFileSha256 を参照。読込前の snapshot（size/mtime/dev/ino）を渡し、
// 解析後に変更・置換されたファイルを重複確定に使わないようにする）。
export async function readJsonl(filePath: string): Promise<ClaudeReadResult> {
  const stat = await fs.stat(filePath);
  const entries: LogEntry[] = [];
  const eventIdStream: string[] = [];
  let skipped = 0;
  await forEachLine(filePath, (line) => {
    if (!line.trim()) return;
    try {
      const entry = JSON.parse(line) as LogEntry;
      entries.push(entry);
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
  };
}
