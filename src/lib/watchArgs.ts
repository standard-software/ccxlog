// Grammar of the watch argv tokens (watch-spec §3.2 / §3.3).
// Only two forms are accepted, `--watch` and `--watch=<positive integer><unit>`;
// anything else is a usage error (exit code 2). The unit is mandatory, single
// and lowercase only, and the number is a positive integer with no leading zero
// (§3.2).

// Upper bound on the run duration D (366 days): the smallest bound that can
// express a full year including a leap year (§3.2).
export const MAX_DURATION_SECONDS = 31_622_400;

// Range of the wait time in seconds (watchIntervalSeconds) (§4.1).
export const MIN_INTERVAL_SECONDS = 1;
export const MAX_INTERVAL_SECONDS = 86_400;
export const DEFAULT_INTERVAL_SECONDS = 5;

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export type WatchToken =
  | { kind: 'watch'; durationSeconds: number | null }   // null = unlimited
  | { kind: 'error'; msg: string };

// Result of validating the right-hand side of `=`. `syntax` means "a shape
// violation that is none of the four §3.2 defines a specific message for
// (missing unit, zero value, leading zero, concatenated units)", and the caller
// reports it with the §3.3 step 3 message `Invalid --watch syntax: …`.
export type DurationResult =
  | { seconds: number }
  | { error: string }
  | { syntax: true };

// Digit count at which the bound is exceeded before the conversion to seconds
// (11 decimal digits or more). This is a range check on the value, not a
// syntactic digit limit (§3.2).
const OVERFLOW_DIGITS = 11;

function rangeError(inner: string): string {
  return `Invalid --watch duration "${inner}": must be between 1s and 366d (${MAX_DURATION_SECONDS} seconds)`;
}

function shapeError(inner: string): string {
  return `Invalid --watch duration "${inner}": use a single positive integer with one unit (s/m/h/d), e.g. --watch=90m`;
}

// Validate the right-hand side of `=` and convert it to seconds. On failure it
// returns the message to print.
export function parseWatchDuration(inner: string): DurationResult {
  // Digits with no unit. `--watch=60` is a usage error.
  if (/^[0-9]+$/.test(inner)) {
    return { error: `Invalid --watch duration "${inner}": a unit is required (s/m/h/d), e.g. --watch=60s` };
  }

  const m = /^([0-9]+)([smhd])$/.exec(inner);
  if (!m) {
    // Concatenated units (`1h30m`) are the one shape §3.2 gives its own message.
    if (/^([0-9]+[smhd]){2,}$/.test(inner)) return { error: shapeError(inner) };
    // Every other shape violation (`1.5m` / `+60s` / `60S` / `s` / ` 60s`) falls
    // outside the watch-opt grammar and is reported with the §3.3 step 3 message.
    return { syntax: true };
  }
  const digits = m[1];
  const unit = m[2];

  if (/^0+$/.test(digits)) {
    return { error: `Invalid --watch duration "${inner}": the value must be a positive integer (1 or greater)` };
  }
  if (digits.startsWith('0')) {
    return { error: `Invalid --watch duration "${inner}": leading zeros are not allowed, e.g. --watch=60s` };
  }
  // Conversion with an overflow check (§3.2).
  if (digits.length >= OVERFLOW_DIGITS) return { error: rangeError(inner) };
  const seconds = Number(digits) * UNIT_SECONDS[unit];
  if (seconds > MAX_DURATION_SECONDS) return { error: rangeError(inner) };
  return { seconds };
}

// Classify one argv token as a watch token. A token that is not one returns
// null, leaving it to the caller's existing scanning rules (§3.3 step 4).
export function classifyWatchToken(token: string): WatchToken | null {
  if (!token.startsWith('--watch')) return null;                     // §3.3 step 4

  // From here on the token is "everything that prefix-matched --watch". It is
  // validated strictly against the watch-opt grammar, and anything outside it is
  // reported as Invalid --watch syntax rather than Unknown option (§3.3 step 3).
  if (token === '--watch') return { kind: 'watch', durationSeconds: null };

  const syntaxError = (): WatchToken => ({
    kind: 'error',
    msg: `Invalid --watch syntax: "${token}": expected --watch or --watch=<n><s|m|h|d>`,
  });

  const m = /^--watch=(.+)$/s.exec(token);
  if (!m) return syntaxError();
  const parsed = parseWatchDuration(m[1]);
  if ('syntax' in parsed) return syntaxError();
  if ('error' in parsed) return { kind: 'error', msg: parsed.error };
  return { kind: 'watch', durationSeconds: parsed.seconds };
}

// Validation of the watchIntervalSeconds setting (§4.2). A bad value warns and
// falls back to the default; it is never fatal.
export function validateIntervalSeconds(v: unknown): { seconds: number; warning?: string } {
  if (v === undefined) return { seconds: DEFAULT_INTERVAL_SECONDS };
  const bad = {
    seconds: DEFAULT_INTERVAL_SECONDS,
    warning: `Warning: watchIntervalSeconds must be an integer between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}; using default (${DEFAULT_INTERVAL_SECONDS}).`,
  };
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return bad;
  if (v < MIN_INTERVAL_SECONDS || v > MAX_INTERVAL_SECONDS) return bad;
  return { seconds: v };
}
