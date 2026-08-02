// The seam for replacing console output. A single run uses plain console as
// before; watch's default (non-verbose) mode discards a cycle's detailed output
// and narrows it to one line per cycle that changed something (watch-spec §9.1).
// It also lets tests capture output.
export interface OutputSink {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const consoleSink: OutputSink = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

// The sink used by watch's default (non-verbose) mode. It discards the detailed
// output and the body of failures (a failure is carried by the cycle's return
// value and reported by the loop in one line) but DOES collect warnings. The
// loop then prints those with consecutive suppression applied (§4.2 / §9.3).
// Discarding them entirely would leave a mistyped template setting or a
// partially failed discovery unnoticed for hours.
export function collectingSink(warnings: string[]): OutputSink {
  return {
    log: () => {},
    warn: (m) => { warnings.push(m); },
    error: () => {},
  };
}
