// Consecutive-warning suppression for warnings raised within a cycle (a bad
// config value, a template diagnostic, a partially failed discovery) —
// watch-spec §4.2 / §9.3. They recur every cycle by nature, so they are
// suppressed like failure lines: while the same content keeps coming they are
// not printed, and they are shown again once 60 seconds have passed.
//
// Timing uses the MONOTONIC clock (§5.4: "the wall clock is for log display
// only"). With a wall clock, NTP corrections, manual changes and DST would move
// the re-display interval around, and in the worst case break it outright —
// warnings going quiet for exactly as long as the clock was set back, or firing
// every cycle for as long as it was set forward. Both clock sources are
// injectable so tests can drive a fake monotonic clock and a fake wall clock
// independently (§11.1).
import { performance } from 'node:perf_hooks';
import type { OutputSink } from './outputSink.js';
import { timePrefix, ERROR_REPEAT_INTERVAL_MS } from './watchRunner.js';

export interface WarningReporter {
  report(warnings: string[]): void;
  /** Carry startup warnings in as the initial state (so cycle 1 does not repeat them at once). */
  prime(warnings: string[]): void;
}

export function createWarningReporter(
  sink: OutputSink,
  now: () => number = () => performance.now(),      // monotonic clock (drives suppression)
  wallClock: () => Date = () => new Date(),         // wall clock (display only)
): WarningReporter {
  let lastKey: string | null = null;
  let shownAt = 0;
  return {
    report(warnings: string[]) {
      const key = warnings.join('\n');
      if (key === '') { lastKey = null; return; }
      if (key !== lastKey || now() - shownAt >= ERROR_REPEAT_INTERVAL_MS) {
        for (const w of warnings) sink.warn(`${timePrefix(wallClock())} ${w}`);
        lastKey = key;
        shownAt = now();
      }
    },
    prime(warnings: string[]) {
      if (warnings.length === 0) return;
      lastKey = warnings.join('\n');
      shownAt = now();
    },
  };
}
