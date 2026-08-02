// The watch loop itself (watch-spec §5, §9.3, §9.5, §10).
// It uses a fixed WAIT: "process -> wait W seconds -> process", not a fixed
// period. The clock, the wait and a single cycle are all injectable, so tests
// never wait on real time (§11.1).
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_INTERVAL_SECONDS } from './watchArgs.js';
import type { OutputSink } from './outputSink.js';

export type WriteKind = 'create' | 'append' | 'rewrite' | 'noop';

export type WriteCounts = Record<WriteKind, number>;

export function emptyWriteCounts(): WriteCounts {
  return { create: 0, append: 0, rewrite: 0, noop: 0 };
}

export interface WatchCycleResult {
  ok: boolean;
  failure?: string;         // one-line reason for the failure (only when ok=false)
  pairs: number;
  writes: WriteCounts;
  changed: boolean;         // the output changed (so one line is reported by default)
  changeLine?: string;      // that cycle's result line (body, without the time prefix)
  writeLabel: string;       // summary of the write result for the --verbose line
  intervalSeconds: number;  // W taken from that cycle's config (a failed cycle uses the default 5)
  // Incremental re-parse breakdown, shown on the --verbose cycle line.
  cache?: { reparsed: number; reused: number };
}

export type StopReason = 'duration' | 'sigint' | 'sigterm';

export interface WatchLoopSummary {
  reason: StopReason;
  cycles: number;
  changed: number;
  failed: number;
  elapsedSeconds: number;
  writes: WriteCounts;
  exitCode: number;
}

export interface WatchLoopOptions {
  durationSeconds: number | null;
  cycle: () => Promise<WatchCycleResult>;
  out: OutputSink;
  verbose: boolean;
  now?: () => number;                                    // monotonic clock (ms)
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  wallClock?: () => Date;                                // display only
}

export interface WatchLoop {
  run(): Promise<WatchLoopSummary>;
  requestStop(reason: StopReason): void;
  /** Is a cycle running? Used to choose the first-Ctrl+C wording (§10.2). */
  isProcessing(): boolean;
}

// How long before the same error is shown again (§9.3 / §11.2).
export const ERROR_REPEAT_INTERVAL_MS = 60_000;

const STOP_LABEL: Record<StopReason, string> = {
  duration: 'duration elapsed',
  sigint: 'interrupted (Ctrl+C)',
  sigterm: 'terminated (SIGTERM)',
};

const STOP_CODE: Record<StopReason, number> = {
  duration: 0,
  sigint: 130,
  sigterm: 143,
};

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// The wall-clock prefix put on cycle-result, failure, recovery and
// suppression-summary lines (display only; elapsed time is judged by the
// monotonic clock — §9.1).
export function timePrefix(d: Date): string {
  return `[${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())} `
    + `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}]`;
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // AbortError: a stop request released the wait (§5.6). No new cycle starts.
  }
}

export function createWatchLoop(opts: WatchLoopOptions): WatchLoop {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? defaultSleep;
  const wallClock = opts.wallClock ?? (() => new Date());
  const out = opts.out;

  let stopReason: StopReason | null = null;
  let running = false;                 // is a cycle running? (used by the §10.2 wording)
  let waitAbort: AbortController | null = null;

  // Consecutive-failure message suppression (§9.3).
  let lastFailure: string | null = null;
  let suppressed = 0;
  let lastFailureShownAt = 0;
  let failedSinceSuccess = 0;

  function stamp(): string {
    return timePrefix(wallClock());
  }

  // The line summarising how many messages were suppressed (§9.3). It says "in
  // the last 60s" only for the periodic re-display after 60 seconds. The flushes
  // on recovery and at shutdown cover a window that is not necessarily 60
  // seconds, so their wording claims no window length.
  function flushSuppressed(periodic: boolean): void {
    if (suppressed > 0) {
      const window = Math.round(ERROR_REPEAT_INTERVAL_MS / 1000);
      out.error(periodic
        ? `${stamp()} (previous error repeated ${suppressed} times in the last ${window}s)`
        : `${stamp()} (previous error repeated ${suppressed} more time(s))`);
      suppressed = 0;
    }
  }

  function reportFailure(msg: string): void {
    if (msg !== lastFailure) {
      flushSuppressed(false);
      out.error(`${stamp()} cycle failed: ${msg}`);
      lastFailure = msg;
      lastFailureShownAt = now();
      return;
    }
    suppressed++;
    if (now() - lastFailureShownAt >= ERROR_REPEAT_INTERVAL_MS) {
      flushSuppressed(true);
      lastFailureShownAt = now();
    }
  }

  function reportSuccess(result: WatchCycleResult): void {
    if (lastFailure !== null) {
      flushSuppressed(false);
      out.log(`${stamp()} recovered: cycle succeeded after ${failedSinceSuccess} failed cycle(s)`);
      lastFailure = null;
    }
    if (result.changed && result.changeLine) out.log(`${stamp()} ${result.changeLine}`);
  }

  function requestStop(reason: StopReason): void {
    if (stopReason === null) stopReason = reason;
    waitAbort?.abort();
  }

  async function run(): Promise<WatchLoopSummary> {
    const writes = emptyWriteCounts();
    let cycles = 0;
    let changed = 0;
    let failed = 0;

    // t0 is taken from the monotonic clock after startup completes and just
    // before the first cycle (§5.4).
    const t0 = now();
    const deadline = opts.durationSeconds === null ? null : t0 + opts.durationSeconds * 1000;

    for (;;) {
      // L1: stop check.
      if (stopReason !== null) break;
      if (deadline !== null && now() >= deadline) { requestStop('duration'); break; }

      // L2: one cycle (never interrupted while it runs — §5.2).
      cycles++;
      if (opts.verbose) out.log(`${stamp()} cycle #${cycles} start`);
      const cycleStart = now();
      running = true;
      let result: WatchCycleResult;
      try {
        result = await opts.cycle();
      } finally {
        running = false;
      }
      const cycleMs = now() - cycleStart;

      for (const k of Object.keys(writes) as WriteKind[]) writes[k] += result.writes[k];
      if (result.ok) {
        if (result.changed) changed++;
        // The recovery notice reports how many failures ran up to it, so the
        // counter is reset only after the report (§9.3).
        reportSuccess(result);
        failedSinceSuccess = 0;
      } else {
        failed++;
        failedSinceSuccess++;
        reportFailure(result.failure ?? 'unknown error');
      }

      // L3: stop check. On reaching the deadline we finish straight from here
      //     rather than waiting pointlessly.
      if (deadline !== null && stopReason === null && now() >= deadline) requestStop('duration');
      const stopping = stopReason !== null;

      // L4: wait. Its length is min(W, time left until the deadline).
      const w = result.intervalSeconds > 0 ? result.intervalSeconds : DEFAULT_INTERVAL_SECONDS;
      let waitMs = stopping ? 0 : w * 1000;
      if (!stopping && deadline !== null) waitMs = Math.min(waitMs, Math.max(0, deadline - now()));
      // The --verbose cycle line is omitted neither for a noop cycle nor for the
      // final cycle (§9.4).
      if (opts.verbose) {
        out.log(`${stamp()} cycle #${cycles} done: ${wallClock().toISOString()}`
          + `, elapsed ${((now() - t0) / 1000).toFixed(1)}s`
          + `, took ${(cycleMs / 1000).toFixed(1)}s`
          + `, ${result.pairs} pair(s), ${result.writeLabel}`
          + (stopping ? ', stopping (no wait)' : `, next wait ${(waitMs / 1000).toFixed(1)}s`)
          // "N files reparsed / M files reused".
          + (result.cache
            ? `, cache ${result.cache.reparsed} reparsed / ${result.cache.reused} reused`
            : ''));
      }
      if (stopping) break;
      // No await sits between the L3 check and here, so no stop request can
      // arrive in between (every request that did is already caught by
      // `stopping` above).
      waitAbort = new AbortController();
      await sleep(waitMs, waitAbort.signal);
      waitAbort = null;
      // L5: back to L1 (releasing the wait only proceeds to shutdown; it never
      //     starts a new cycle).
    }

    flushSuppressed(false);
    const reason = stopReason ?? 'duration';
    const elapsedSeconds = (now() - t0) / 1000;
    return {
      reason,
      cycles,
      changed,
      failed,
      elapsedSeconds,
      writes,
      exitCode: STOP_CODE[reason],
    };
  }

  return {
    run,
    requestStop,
    isProcessing: () => running,
  };
}

// The shutdown summary (§9.5). It carries no time prefix.
export function formatSummary(s: WatchLoopSummary): string[] {
  return [
    `ccxlog watch stopped (${STOP_LABEL[s.reason]}): ${s.cycles} cycle(s), ${s.changed} changed, ${s.failed} failed, ran ${s.elapsedSeconds.toFixed(1)}s`,
    `  writes: ${s.writes.create} create, ${s.writes.append} append, ${s.writes.rewrite} rewrite, ${s.writes.noop} noop`,
  ];
}
