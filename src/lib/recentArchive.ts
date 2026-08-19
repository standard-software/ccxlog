import path from 'node:path';
import type { UnifiedPair } from './types.js';

export const DEFAULT_RECENT_DAYS = 8;

export function archiveNow(): Date {
  // Deterministic integration tests without making the production clock a
  // user-facing setting.
  if (process.env.NODE_ENV === 'test' && process.env.CCXLOG_TEST_NOW) {
    const parsed = new Date(process.env.CCXLOG_TEST_NOW);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export function archiveFileName(aggregateFileName: string): string {
  const ext = path.extname(aggregateFileName);
  const stem = ext === '' ? aggregateFileName : aggregateFileName.slice(0, -ext.length);
  return `${stem}_archive${ext}`;
}

// The local calendar date containing `now` is day 1. Thus the default 8 keeps
// today and the same weekday from the previous week.
export function recentCutoffMs(recentDays: number, now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (recentDays - 1)).getTime();
}

export function splitRecentPairs(
  pairs: UnifiedPair[],
  recentDays: number,
  now = archiveNow(),
): { recent: UnifiedPair[]; archive: UnifiedPair[] } {
  const cutoff = recentCutoffMs(recentDays, now);
  const recent: UnifiedPair[] = [];
  const archive: UnifiedPair[] = [];
  for (const pair of pairs) {
    // An unknown timestamp cannot safely be classified as old. Keep it in the
    // everyday file so it remains visible rather than silently disappearing
    // into the archive.
    if (pair.questionTimestampMs === null || pair.questionTimestampMs >= cutoff) recent.push(pair);
    else archive.push(pair);
  }
  return { recent, archive };
}
