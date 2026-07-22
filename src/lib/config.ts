import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TEMPLATE } from './templates.js';

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
  outputAllFileName: string;
  templateRaw: string | undefined;   // raw config value (undefined if unset)
  templateExplicit: boolean;
  template: string;                  // resolved template CONTENT
  claude: {
    outputAllFileName: string;
    outputSessionFilePrefix: string;
    extraLogDirs: RootSpec[];
    includeSidechain: boolean;
  };
  codex: {
    outputAllFileName: string;
    outputSessionFilePrefix: string;
    extraLogDirs: RootSpec[];
    includeDeveloperMessages: boolean;
  };
}

export function defaultConfig(): CcxlogConfig {
  return {
    extraCwds: [],
    includeSubdirectories: true,
    outputAllFileName: 'ccxlog.md',
    templateRaw: undefined,
    templateExplicit: false,
    template: DEFAULT_TEMPLATE,
    claude: {
      outputAllFileName: 'cclog.md',
      outputSessionFilePrefix: 'cclog_',
      extraLogDirs: [],
      includeSidechain: false,
    },
    codex: {
      outputAllFileName: 'cxlog.md',
      outputSessionFilePrefix: 'cxlog_',
      extraLogDirs: [],
      includeDeveloperMessages: false,
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

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function isReservedName(name: string): boolean {
  // Windows blocks reserved names with ANY extension ("CON.a.b" too), so the
  // base is everything before the FIRST dot, not just before the last one.
  const base = name.split('.')[0];
  return RESERVED.test(base);
}

function hasControlOrNul(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // C0 + NUL (<=0x1f), DEL (0x7f), and C1 controls (0x80-0x9f).
    if (c <= 0x1f || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return true;
  }
  return false;
}

function hasPathSep(s: string): boolean {
  return s.includes('/') || s.includes('\\');
}

// Validate an aggregate file NAME (not a prefix). Returns an error message or null.
function validateAggregateName(name: string, label: string): string | null {
  if (name === '') return `${label} must not be empty.`;
  if (hasPathSep(name)) return `${label} must not contain path separators (/ or \\): "${name}".`;
  if (hasControlOrNul(name)) return `${label} must not contain control characters or NUL.`;
  if (name === '.' || name === '..') return `${label} must not be "." or "..".`;
  if (path.isAbsolute(name)) return `${label} must not be an absolute path: "${name}".`;
  if (/[ .]$/.test(name)) return `${label} must not end with a space or period: "${name}".`;
  if (isReservedName(name)) return `${label} must not be a Windows reserved name: "${name}".`;
  return null;
}

// Validate a session-file PREFIX (empty allowed).
function validatePrefix(name: string, label: string): string | null {
  if (name === '') return null;
  if (hasPathSep(name)) return `${label} must not contain path separators (/ or \\): "${name}".`;
  if (hasControlOrNul(name)) return `${label} must not contain control characters or NUL.`;
  if (name === '.' || name === '..') return `${label} must not be "." or "..".`;
  if (path.isAbsolute(name)) return `${label} must not be an absolute path: "${name}".`;
  if (/[ .]$/.test(name)) return `${label} must not end with a space or period: "${name}".`;
  if (isReservedName(name)) return `${label} must not be a Windows reserved name: "${name}".`;
  return null;
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

// Read a string config value. A present-but-non-string value is a silent path
// to writing an unintended file (§4.1), so warn — symmetrically with asBool —
// rather than defaulting quietly.
function asString(v: unknown, fallback: string, label: string, warnings: string[]): string {
  if (v === undefined) return fallback;
  if (typeof v === 'string') return v;
  warnings.push(`Warning: ${label} must be a string; using default ("${fallback}").`);
  return fallback;
}

const TOP_KEYS = new Set(['extraCwds', 'includeSubdirectories', 'outputAllFileName', 'template', 'claude', 'codex']);
const CLAUDE_KEYS = new Set(['outputAllFileName', 'outputSessionFilePrefix', 'extraLogDirs', 'includeSidechain']);
const CODEX_KEYS = new Set(['outputAllFileName', 'outputSessionFilePrefix', 'extraLogDirs', 'includeDeveloperMessages']);

function checkUnknownKeys(obj: Record<string, unknown>, warnings: string[]): void {
  for (const key of Object.keys(obj)) {
    if (TOP_KEYS.has(key)) continue;
    if (key === 'recursive') {
      warnings.push('Warning: config key "recursive" is not supported; recursion is selected automatically for each source.');
    } else if (key === 'includeSidechain' || key === 'includeDeveloperMessages') {
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
  for (const key of Object.keys(claude)) {
    if (key === 'recursive') {
      warnings.push('Warning: config key "claude.recursive" is no longer supported; Claude Code log discovery is non-recursive.');
    } else if (!CLAUDE_KEYS.has(key)) warnings.push(`Warning: unknown "claude.${key}" config key; ignoring it.`);
  }
  for (const key of Object.keys(codex)) {
    if (key === 'recursive') {
      warnings.push('Warning: config key "codex.recursive" is no longer supported; Codex log discovery is recursive.');
    } else if (!CODEX_KEYS.has(key)) warnings.push(`Warning: unknown "codex.${key}" config key; ignoring it.`);
  }

  config.extraCwds = asStringArray(obj.extraCwds, 'extraCwds', warnings);
  config.includeSubdirectories = asBool(obj.includeSubdirectories, config.includeSubdirectories, 'includeSubdirectories', warnings);
  config.outputAllFileName = asString(obj.outputAllFileName, config.outputAllFileName, 'outputAllFileName', warnings);
  config.claude.outputAllFileName = asString(claude.outputAllFileName, config.claude.outputAllFileName, 'claude.outputAllFileName', warnings);
  config.codex.outputAllFileName = asString(codex.outputAllFileName, config.codex.outputAllFileName, 'codex.outputAllFileName', warnings);
  config.claude.outputSessionFilePrefix = asString(claude.outputSessionFilePrefix, config.claude.outputSessionFilePrefix, 'claude.outputSessionFilePrefix', warnings);
  config.codex.outputSessionFilePrefix = asString(codex.outputSessionFilePrefix, config.codex.outputSessionFilePrefix, 'codex.outputSessionFilePrefix', warnings);
  config.claude.includeSidechain = asBool(claude.includeSidechain, config.claude.includeSidechain, 'claude.includeSidechain', warnings);
  config.codex.includeDeveloperMessages = asBool(codex.includeDeveloperMessages, config.codex.includeDeveloperMessages, 'codex.includeDeveloperMessages', warnings);
  config.claude.extraLogDirs = asRootSpecArray(claude.extraLogDirs, 'claude.extraLogDirs', warnings);
  config.codex.extraLogDirs = asRootSpecArray(codex.extraLogDirs, 'codex.extraLogDirs', warnings);

  // Fatal filename validation (§4.3).
  const nameChecks: Array<[string, string]> = [
    [config.outputAllFileName, 'outputAllFileName'],
    [config.claude.outputAllFileName, 'claude.outputAllFileName'],
    [config.codex.outputAllFileName, 'codex.outputAllFileName'],
  ];
  for (const [name, label] of nameChecks) {
    const err = validateAggregateName(name, label);
    if (err) errors.push(err);
  }
  const prefixChecks: Array<[string, string]> = [
    [config.claude.outputSessionFilePrefix, 'claude.outputSessionFilePrefix'],
    [config.codex.outputSessionFilePrefix, 'codex.outputSessionFilePrefix'],
  ];
  for (const [name, label] of prefixChecks) {
    const err = validatePrefix(name, label);
    if (err) errors.push(err);
  }

  // Aggregate-name collision (§4.4): 2+ of the 3 identical (win32 case-fold).
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const names = [config.outputAllFileName, config.claude.outputAllFileName, config.codex.outputAllFileName];
  const seen = new Map<string, number>();
  for (const n of names) seen.set(norm(n), (seen.get(norm(n)) ?? 0) + 1);
  for (const count of seen.values()) {
    if (count >= 2) {
      errors.push(`Two or more aggregate file names collide: [${names.join(', ')}]. Each of outputAllFileName / claude.outputAllFileName / codex.outputAllFileName must be distinct.`);
      break;
    }
  }

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
