import path from 'node:path';
import type { CliOptions, SourceMode } from './types.js';

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
  let sourceOpt: string | undefined;
  let perSession = false;
  let dryRun = false;
  let verbose = false;
  let initTemplate = false;
  let backupJsonl = false;
  let backupMd = false;
  let lock = false;
  let forceUnlock = false;
  // Help/version are recorded but DO NOT short-circuit the scan: a mixed-in
  // unknown or malformed option must still produce a usage error (§3.2,
  // §13-6). They are only honoured after a fully clean scan.
  let wantHelp = false;
  let wantVersion = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') {
      const v = args[++i];
      if (!v || v.startsWith('-')) return { kind: 'error', msg: '--out requires a directory value' };
      outDir = v;
    } else if (a === '--source') {
      const v = args[++i];
      if (!v || v.startsWith('-')) return { kind: 'error', msg: '--source requires a value (both|claude|codex)' };
      if (v !== 'both' && v !== 'claude' && v !== 'codex') {
        return { kind: 'error', msg: `Invalid --source value: ${v} (expected both|claude|codex)` };
      }
      sourceOpt = v;
    } else if (a === '-cc' || a === '--claude-only') {
      claudeOnly = true;
    } else if (a === '-cx' || a === '--codex-only') {
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
      if (projectPath === null) projectPath = a;
      else return { kind: 'error', msg: `Unexpected positional argument: ${a}` };
    }
  }

  // Only honour help/version after the whole scan proved free of unknown or
  // malformed options (§3.2). Help wins over version if both were given.
  if (wantHelp) return { kind: 'help' };
  if (wantVersion) return { kind: 'version' };

  // Mode decision table (§2.1).
  if (claudeOnly && codexOnly) {
    return { kind: 'error', msg: '-cc and -cx cannot be combined.' };
  }
  const cliMode: SourceMode | undefined = claudeOnly ? 'claude' : codexOnly ? 'codex' : undefined;
  if (cliMode && sourceOpt && cliMode !== sourceOpt) {
    return { kind: 'error', msg: `Conflicting source selection: ${claudeOnly ? '-cc' : '-cx'} vs --source ${sourceOpt}.` };
  }
  const mode: SourceMode = (cliMode ?? (sourceOpt as SourceMode | undefined) ?? 'both');

  // Standalone-action exclusivity (§3.2).
  const standalone = [
    initTemplate ? '--init-template' : '',
    backupJsonl ? '--backup-jsonl' : '',
    backupMd ? '--backup-md' : '',
  ].filter(Boolean);
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
      lock,
      forceUnlock,
    },
  };
}
