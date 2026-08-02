import path from 'node:path';
import type { CliOptions, SourceMode } from './types.js';
import { classifyWatchToken } from './watchArgs.js';

export type ParseResult =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; msg: string }   // usage error -> exit code 2
  | { kind: 'ok'; opts: CliOptions };

export function parseArgs(argv: string[]): ParseResult {
  const args = argv.slice(2);
  let projectPath: string | null = null;
  let outDir: string | null = null;
  let claudeOnly = false;
  let codexOnly = false;
  let perSession = false;
  let dryRun = false;
  let verbose = false;
  let initTemplate = false;
  let backupJsonl = false;
  let backupMd = false;
  let lock = false;
  let forceUnlock = false;
  let watch = false;
  let watchDurationSeconds: number | null = null;
  let watchTokens = 0;   // how many `--watch` tokens appeared (two or more is a usage error, §3.3)
  // Help/version are recorded but DO NOT short-circuit the scan: a mixed-in
  // unknown or malformed option must still produce a usage error (§3.2,
  // §13-6). They are only honoured after a fully clean scan.
  let wantHelp = false;
  let wantVersion = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // Tokens that prefix-match `--watch` are classified ahead of the existing
    // scanning rules (§3.3 step 3). Anything outside the grammar is reported as
    // `Invalid --watch syntax`, not as an Unknown option.
    const wt = classifyWatchToken(a);
    if (wt) {
      watchTokens++;
      if (wt.kind === 'error') return { kind: 'error', msg: wt.msg };
      watch = true;
      watchDurationSeconds = wt.durationSeconds;
      continue;
    }
    if (a === '--out') {
      const v = args[++i];
      if (!v || v.startsWith('-')) return { kind: 'error', msg: '--out requires a directory value' };
      outDir = v;
    } else if (a === '-cc') {
      claudeOnly = true;
    } else if (a === '-cx') {
      codexOnly = true;
    } else if (a === '--per-session') {
      perSession = true;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--verbose') {
      verbose = true;
    } else if (a === '--init-template') {
      initTemplate = true;
    } else if (a === '--backup-jsonl') {
      backupJsonl = true;
    } else if (a === '--backup-md') {
      backupMd = true;
    } else if (a === '--lock') {
      lock = true;
    } else if (a === '--force-unlock') {
      forceUnlock = true;
    } else if (a === '--version' || a === '-v' || a === '-V') {
      wantVersion = true;
    } else if (a === '--help' || a === '-h') {
      wantHelp = true;
    } else if (a.startsWith('-')) {
      return { kind: 'error', msg: `Unknown option: ${a}` };
    } else {
      // Accepting a duration written with a space (`--watch 60s`) as the project
      // path would silently watch the current directory forever (§3.3).
      if (watch && /^[0-9]+[A-Za-z]+$/.test(a)) {
        return { kind: 'error', msg: 'Duration must use equals with --watch (e.g. --watch=60s)' };
      }
      if (projectPath === null) projectPath = a;
      else return { kind: 'error', msg: `Unexpected positional argument: ${a}` };
    }
  }

  // The list of standalone actions is used both by the --watch combination check
  // (§3.5) and by the mutual-exclusion check between standalone actions (§3.2).
  // --watch is validated BEFORE help/version, so a usage error neither prints
  // help/version nor starts a watch (§3.3 / §13 A-4).
  const standalone = [
    initTemplate ? '--init-template' : '',
    backupJsonl ? '--backup-jsonl' : '',
    backupMd ? '--backup-md' : '',
  ].filter(Boolean);
  if (watchTokens >= 2) {
    return {
      kind: 'error',
      msg: 'Only one of --watch or --watch=<n><unit> may be given.',
    };
  }
  if (watch) {
    // Combining them would tear off someone else's lock on every cycle, so it is
    // rejected (§3.5). To clear a stale lock before watching, run a one-shot
    // `ccxlog --lock --force-unlock` first — the message runWatch() prints on a
    // lock conflict says exactly that.
    if (forceUnlock) {
      return {
        kind: 'error',
        msg: '--watch cannot be combined with --force-unlock. '
          + 'Clear a stale lock first with: ccxlog --lock --force-unlock',
      };
    }
    if (standalone.length > 0) {
      return { kind: 'error', msg: `--watch cannot be combined with ${standalone[0]}` };
    }
  }
  if (forceUnlock && !lock) {
    return { kind: 'error', msg: '--force-unlock requires --lock.' };
  }

  // Only honour help/version after the whole scan proved free of unknown or
  // malformed options (§3.2). Help wins over version if both were given.
  if (wantHelp) return { kind: 'help' };
  if (wantVersion) return { kind: 'version' };

  // Mode decision table (§2.1).
  if (claudeOnly && codexOnly) {
    return { kind: 'error', msg: '-cc and -cx cannot be combined.' };
  }
  const mode: SourceMode = claudeOnly ? 'claude' : codexOnly ? 'codex' : 'both';

  // Standalone-action exclusivity (§3.2).
  if (standalone.length > 1) {
    return { kind: 'error', msg: `Options are mutually exclusive: ${standalone.join(', ')}` };
  }
  if (perSession && standalone.length > 0) {
    return { kind: 'error', msg: `--per-session cannot be combined with ${standalone[0]}` };
  }

  const finalProjectPath = path.resolve(projectPath ?? process.cwd());
  const finalOutDir = path.resolve(outDir ?? path.join(finalProjectPath, 'CCXLOG'));
  return {
    kind: 'ok',
    opts: {
      projectPath: finalProjectPath,
      outDir: finalOutDir,
      mode,
      perSession,
      dryRun,
      verbose,
      initTemplate,
      backupJsonl,
      backupMd,
      // A watch holds the output lock for its full process lifetime. Explicit
      // --lock remains accepted for compatibility but is not required.
      lock: lock || watch,
      forceUnlock,
      watch,
      watchDurationSeconds,
    },
  };
}
