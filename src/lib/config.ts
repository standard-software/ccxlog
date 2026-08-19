import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TEMPLATE } from './templates.js';
import { DEFAULT_INTERVAL_SECONDS, validateIntervalSeconds } from './watchArgs.js';
import { DEFAULT_RECENT_DAYS } from './recentArchive.js';

// Package root: two levels up from dist/lib/config.js.
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONFIG_FILE_NAME = 'ccxlog.config.json';

export interface RootSpec { dir: string; key?: string; }

export interface CcxlogConfig {
  extraCwds: string[];
  // Top-level (shared by both sources, like cclog's includeSubdirectories):
  // when true (default), also collect logs from projects whose cwd is nested
  // UNDER the target project — e.g. running in ~/work/app also picks up
  // ~/work/app/frontend. Nested candidates are always confirmed against each
  // session's real cwd, so a same-prefix sibling (~/work/app-backup) is never
  // pulled in. Set false to restore exact-project-only matching (plus
  // extraCwds / extraLogDirs).
  includeSubdirectories: boolean;
  // The watch wait time in seconds (watch-spec §4) — the wait in "process ->
  // wait this many seconds -> process". A run without watch reads it but never
  // uses it (which is neither a warning nor an error).
  watchIntervalSeconds: number;
  recentDays: number;
  autoBackupGraceMinutes: number;
  templateRaw: string | undefined;   // raw config value (undefined if unset)
  templateExplicit: boolean;
  template: string;                  // resolved template CONTENT
  claude: {
    extraLogDirs: RootSpec[];
    // The RESOLVED display setting for subagent conversations (spec §5).
    // `claude.includeSubagents` is the official key; `claude.includeSidechain`
    // is kept as its supported former name and resolved into this one field, so
    // nothing downstream has to know that two spellings exist.
    includeSubagents: boolean;
  };
  codex: {
    extraLogDirs: RootSpec[];
    includeDeveloperMessages: boolean;
    // Codex has one spelling only: `codex.includeSubagents`. `includeSidechain`
    // is a Claude-log term and is deliberately NOT accepted here (spec §5.3), so
    // it falls through to the ordinary unknown-key warning.
    includeSubagents: boolean;
  };
}

export function defaultConfig(): CcxlogConfig {
  return {
    extraCwds: [],
    includeSubdirectories: true,
    watchIntervalSeconds: DEFAULT_INTERVAL_SECONDS,
    recentDays: DEFAULT_RECENT_DAYS,
    autoBackupGraceMinutes: 10,
    templateRaw: undefined,
    templateExplicit: false,
    template: DEFAULT_TEMPLATE,
    claude: {
      extraLogDirs: [],
      // Both sources default to true (spec §5.1): a complete conversation record
      // is the standard behaviour, and it makes the migration purely additive.
      includeSubagents: true,
    },
    codex: {
      extraLogDirs: [],
      includeDeveloperMessages: false,
      includeSubagents: true,
    },
  };
}

export interface LoadConfigResult {
  config: CcxlogConfig;
  source: 'file' | 'default';
  path: string;
  errors: string[];     // fatal (code 1)
  warnings: string[];   // non-fatal
}







function asStringArray(v: unknown, label: string, warnings: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) { warnings.push(`Warning: ${label} must be an array; ignoring it.`); return []; }
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string') out.push(x);
    else warnings.push(`Warning: ${label} contains a non-string element; ignoring it.`);
  }
  return out;
}

const ALIAS_RE = /^[A-Za-z0-9._-]+$/;

function asRootSpecArray(v: unknown, label: string, warnings: string[]): RootSpec[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) { warnings.push(`Warning: ${label} must be an array; ignoring it.`); return []; }
  const out: RootSpec[] = [];
  for (const x of v) {
    if (typeof x === 'string') { out.push({ dir: x }); continue; }
    if (x && typeof x === 'object' && typeof (x as RootSpec).dir === 'string') {
      const spec = x as RootSpec;
      let key = typeof spec.key === 'string' ? spec.key : undefined;
      if (key !== undefined && !ALIAS_RE.test(key)) {
        warnings.push(`Warning: ${label} alias "${key}" has invalid characters; falling back to a hash key.`);
        key = undefined;
      }
      out.push({ dir: spec.dir, key });
      continue;
    }
    warnings.push(`Warning: ${label} contains an invalid element; ignoring it.`);
  }
  return out;
}

function asBool(v: unknown, fallback: boolean, label: string, warnings: string[]): boolean {
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  warnings.push(`Warning: ${label} must be a boolean; using default (${fallback}).`);
  return fallback;
}

// Read a boolean config value that may be absent. Unlike asBool() this reports
// "not specified" as undefined instead of substituting a default, because the
// caller has to tell an unset key apart from one that was explicitly set to the
// default value (spec §5.2). A non-boolean value warns exactly as asBool does
// and then resolves as unspecified (§5.2 rule 5).
function asOptionalBool(v: unknown, fallback: boolean, label: string, warnings: string[]): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  warnings.push(`Warning: ${label} must be a boolean; using default (${fallback}).`);
  return undefined;
}

// Resolve claude.includeSubagents from the official key and its former name
// (spec §5.2). The two spellings mean the same thing, so agreeing values are
// accepted and a genuine disagreement is fatal: silently preferring one of them
// would make the run do the opposite of what half the config asks for, and the
// choice would be invisible in the output.
function resolveClaudeIncludeSubagents(
  official: boolean | undefined,
  legacy: boolean | undefined,
  fallback: boolean,
  errors: string[],
): boolean {
  if (official !== undefined && legacy !== undefined && official !== legacy) {
    errors.push(
      `claude.includeSubagents (${official}) and claude.includeSidechain (${legacy}) are set to different values. `
      + 'They are the same setting under two names; set them to the same value, or keep only claude.includeSubagents.',
    );
    // The value is unusable, but loadConfig reports every error it can find in
    // one pass rather than stopping here; the caller aborts before any side
    // effect, so what is returned is never acted on.
    return fallback;
  }
  return official ?? legacy ?? fallback;
}


function asPositiveInteger(v: unknown, fallback: number, label: string, warnings: string[]): number {
  if (v === undefined) return fallback;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1) return v;
  warnings.push(`Warning: ${label} must be an integer of 1 or greater; using default (${fallback}).`);
  return fallback;
}

const TOP_KEYS = new Set(['extraCwds', 'includeSubdirectories', 'watchIntervalSeconds', 'recentDays', 'autoBackupGraceMinutes', 'template', 'claude', 'codex']);
const CLAUDE_KEYS = new Set(['extraLogDirs', 'includeSubagents', 'includeSidechain']);
const CODEX_KEYS = new Set(['extraLogDirs', 'includeDeveloperMessages', 'includeSubagents']);

// Output file names are no longer configurable (v1.9.0). These keys are a
// FATAL error rather than an ignored unknown key: ignoring them would quietly
// move the output to a different file and leave the user's existing one behind
// under a name nothing reads any more — the silent-loss shape this release
// exists to remove. Stopping lets the reader rename the file or drop the key
// deliberately.
const REMOVED_NAME_KEYS = new Map<string, string>([
  ['outputAllFileName', 'ccxlog.md'],
  ['claude.outputAllFileName', 'cclog.md'],
  ['codex.outputAllFileName', 'cxlog.md'],
  ['claude.outputSessionFilePrefix', 'cclog_'],
  ['codex.outputSessionFilePrefix', 'cxlog_'],
]);

function checkRemovedKeys(
  obj: Record<string, unknown>,
  claude: Record<string, unknown>,
  codex: Record<string, unknown>,
  errors: string[],
): void {
  const present: Array<[string, unknown]> = [
    ...Object.keys(obj).map(k => [k, obj[k]] as [string, unknown]),
    ...Object.keys(claude).map(k => [`claude.${k}`, claude[k]] as [string, unknown]),
    ...Object.keys(codex).map(k => [`codex.${k}`, codex[k]] as [string, unknown]),
  ];
  for (const [key] of present) {
    const fixed = REMOVED_NAME_KEYS.get(key);
    if (fixed === undefined) continue;
    errors.push(
      `${key} is no longer supported: output file names are fixed (${fixed} here). `
      + 'Use --out to choose the output directory instead, then remove this key. '
      + 'If output already exists under your own name, rename it first so its history is kept.',
    );
  }
}

function checkUnknownKeys(obj: Record<string, unknown>, warnings: string[]): void {
  for (const key of Object.keys(obj)) {
    if (TOP_KEYS.has(key)) continue;
    // A removed key is recognised, not unknown: checkRemovedKeys reports it as
    // a fatal error, and warning "ignoring it" beside that error would be a
    // contradiction (the run is in fact stopping because of the key).
    if (REMOVED_NAME_KEYS.has(key)) continue;
    if (key === 'recursive') {
      warnings.push('Warning: config key "recursive" is not supported; recursion is selected automatically for each source.');
    } else if (key === 'includeSubagents' || key === 'includeSidechain' || key === 'includeDeveloperMessages') {
      warnings.push(`Warning: unknown top-level config key "${key}"; put it under "claude.*" or "codex.*".`);
    } else if (key === 'source' || key === 'sources') {
      warnings.push(`Warning: config key "${key}" is not supported; the source is selected on the CLI (-cc/-cx).`);
    } else {
      warnings.push(`Warning: unknown top-level config key "${key}"; ignoring it.`);
    }
  }
}

async function readableFile(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

// Template resolution order (§4.5). Only invoked when template is explicitly
// set. Returns { content } or { error }.
async function resolveTemplate(
  templateValue: string,
  outDir: string,
  projectDir: string,
): Promise<{ content?: string; error?: string }> {
  if (path.isAbsolute(templateValue)) {
    const content = await readableFile(templateValue);
    if (content !== null) return { content };
    return { error: `template not found at absolute path: ${templateValue}` };
  }
  for (const base of [outDir, projectDir, PACKAGE_ROOT]) {
    const candidate = path.join(base, templateValue);
    const content = await readableFile(candidate);
    if (content !== null) return { content };
  }
  return { error: `template "${templateValue}" not found under <out>, <project>, or <packageRoot>.` };
}

export async function loadConfig(
  outDir: string,
  projectDir: string,
): Promise<LoadConfigResult> {
  const fpath = path.join(outDir, CONFIG_FILE_NAME);
  const errors: string[] = [];
  const warnings: string[] = [];
  const config = defaultConfig();

  let raw: string;
  try {
    raw = await fs.readFile(fpath, 'utf-8');
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { config, source: 'default', path: fpath, errors, warnings };
    }
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push(`${fpath} is not valid JSON.`);
    return { config, source: 'file', path: fpath, errors, warnings };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push(`${fpath} root must be a JSON object.`);
    return { config, source: 'file', path: fpath, errors, warnings };
  }

  const obj = parsed as Record<string, unknown>;
  checkUnknownKeys(obj, warnings);
  const claude = (obj.claude && typeof obj.claude === 'object' && !Array.isArray(obj.claude))
    ? obj.claude as Record<string, unknown> : {};
  const codex = (obj.codex && typeof obj.codex === 'object' && !Array.isArray(obj.codex))
    ? obj.codex as Record<string, unknown> : {};
  checkRemovedKeys(obj, claude, codex, errors);
  for (const key of Object.keys(claude)) {
    if (key === 'recursive') {
      warnings.push('Warning: config key "claude.recursive" is no longer supported; Claude Code log discovery is non-recursive.');
    } else if (!CLAUDE_KEYS.has(key) && !REMOVED_NAME_KEYS.has(`claude.${key}`)) warnings.push(`Warning: unknown "claude.${key}" config key; ignoring it.`);
  }
  for (const key of Object.keys(codex)) {
    if (key === 'recursive') {
      warnings.push('Warning: config key "codex.recursive" is no longer supported; Codex log discovery is recursive.');
    } else if (!CODEX_KEYS.has(key) && !REMOVED_NAME_KEYS.has(`codex.${key}`)) warnings.push(`Warning: unknown "codex.${key}" config key; ignoring it.`);
  }

  config.extraCwds = asStringArray(obj.extraCwds, 'extraCwds', warnings);
  config.includeSubdirectories = asBool(obj.includeSubdirectories, config.includeSubdirectories, 'includeSubdirectories', warnings);
  // watchIntervalSeconds follows the same "warn + default" shape as asBool /
  // asString (§4.2). A bad wait time cannot damage a file, so it is not fatal.
  const interval = validateIntervalSeconds(obj.watchIntervalSeconds);
  config.watchIntervalSeconds = interval.seconds;
  if (interval.warning) warnings.push(interval.warning);
  config.recentDays = asPositiveInteger(obj.recentDays, config.recentDays, 'recentDays', warnings);
  if (obj.autoBackupGraceMinutes !== undefined) {
    if (typeof obj.autoBackupGraceMinutes === 'number'
      && Number.isSafeInteger(obj.autoBackupGraceMinutes)
      && obj.autoBackupGraceMinutes >= 1
      && obj.autoBackupGraceMinutes <= 60) {
      config.autoBackupGraceMinutes = obj.autoBackupGraceMinutes;
    } else {
      errors.push('autoBackupGraceMinutes must be an integer from 1 through 60 (minutes).');
    }
  }
  // Subagent display (spec §5.2). The official key and its former name are read
  // separately — a value of `undefined` here means "not specified", which is
  // what the resolution rules are written in terms of.
  config.claude.includeSubagents = resolveClaudeIncludeSubagents(
    asOptionalBool(claude.includeSubagents, config.claude.includeSubagents, 'claude.includeSubagents', warnings),
    asOptionalBool(claude.includeSidechain, config.claude.includeSubagents, 'claude.includeSidechain', warnings),
    config.claude.includeSubagents,
    errors,
  );
  config.codex.includeSubagents = asBool(codex.includeSubagents, config.codex.includeSubagents, 'codex.includeSubagents', warnings);
  config.codex.includeDeveloperMessages = asBool(codex.includeDeveloperMessages, config.codex.includeDeveloperMessages, 'codex.includeDeveloperMessages', warnings);
  config.claude.extraLogDirs = asRootSpecArray(claude.extraLogDirs, 'claude.extraLogDirs', warnings);
  config.codex.extraLogDirs = asRootSpecArray(codex.extraLogDirs, 'codex.extraLogDirs', warnings);

  // Template (§4.5): the built-in default applies ONLY when the key is absent.
  // An explicit value is resolved; an explicit EMPTY value is a fatal error
  // (neither a resolvable path nor "unset"), not a silent fallback.
  if ('template' in obj && obj.template !== undefined) {
    if (typeof obj.template !== 'string') {
      warnings.push('Warning: template must be a string; using the built-in default.');
    } else if (obj.template.trim() === '') {
      errors.push('template is set to an empty value; set a real path or remove the key to use the built-in default.');
    } else {
      config.templateRaw = obj.template;
      config.templateExplicit = true;
      const resolved = await resolveTemplate(obj.template, outDir, projectDir);
      if (resolved.error) errors.push(resolved.error);
      else if (resolved.content !== undefined) config.template = resolved.content;
    }
  }

  return { config, source: 'file', path: fpath, errors, warnings };
}
