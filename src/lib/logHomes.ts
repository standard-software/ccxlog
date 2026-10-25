import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { CcxlogConfig } from './config.js';
import type { Source } from './types.js';
import { canonicalPath, sha256HexBytes } from './pathUtils.js';

// Log homes (v1.14.0): the config directories a source writes its logs under.
//
// Claude Code keeps everything in ~/.claude unless CLAUDE_CONFIG_DIR names
// another directory, and people who use several accounts keep one directory per
// account (~/.claude-work, say) and set the variable only while Claude runs.
// Codex does the same with CODEX_HOME. The variable is gone by the time
// ccxlog runs, often in another terminal, so it cannot be relied on: the home
// directory is also searched for directories that look like a config dir
// (configDirGlobs) and actually hold logs.
//
// The default home always comes first and keeps the stable key 'std', so the
// ids derived from it are what they were before. Every other home gets a key
// from its canonical path, so the same file name under two homes never maps to
// the same id.
export interface LogHome {
  dir: string;
  key: string;
  // How it was found, for --verbose.
  found: 'default' | 'env' | 'glob';
  // The account logged in there now, '' when it cannot be told.
  account: string;
}

const LOG_SUBDIR: Record<Source, string> = { claude: 'projects', codex: 'sessions' };
const DEFAULT_NAME: Record<Source, string> = { claude: '.claude', codex: '.codex' };
const ENV_NAME: Record<Source, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

export function logSubdir(source: Source): string {
  return LOG_SUBDIR[source];
}

// A configDirGlobs entry matches one name directly in the home directory. Only
// '*' and '?' are special; a name is compared case-insensitively on Windows,
// as the filesystem does.
export function globToRegExp(glob: string): RegExp {
  const body = glob.split('').map(c => {
    if (c === '*') return '.*';
    if (c === '?') return '.';
    return c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${body}$`, process.platform === 'win32' ? 'i' : '');
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function findLogHomes(source: Source, cfg: CcxlogConfig): Promise<LogHome[]> {
  const home = os.homedir();
  const sub = LOG_SUBDIR[source];
  const candidates: Array<{ dir: string; found: LogHome['found'] }> = [
    { dir: path.join(home, DEFAULT_NAME[source]), found: 'default' },
  ];
  const fromEnv = process.env[ENV_NAME[source]];
  if (fromEnv && fromEnv.trim()) candidates.push({ dir: path.resolve(fromEnv.trim()), found: 'env' });
  if (cfg.autoDiscover) {
    const globs = cfg[source].configDirGlobs.map(globToRegExp);
    let names: string[] = [];
    try {
      names = (await fs.readdir(home)).sort();
    } catch {
      // An unreadable home leaves the default and the variable.
    }
    for (const name of names) {
      if (globs.some(g => g.test(name))) candidates.push({ dir: path.join(home, name), found: 'glob' });
    }
  }

  const homes: LogHome[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const canon = await canonicalPath(c.dir);
    if (seen.has(canon)) continue;
    // The default is kept even without logs, as before (discovery skips a
    // missing root). Anything else must hold the log directory: a name like
    // .claude.json or .claude-code-viewer is not a config dir.
    if (c.found !== 'default' && !await isDir(path.join(c.dir, sub))) continue;
    seen.add(canon);
    homes.push({
      dir: c.dir,
      key: c.found === 'default' ? 'std' : `home-${sha256HexBytes(canon, 12)}`,
      found: c.found,
      account: await accountOf(source, c.dir, c.found === 'default'),
    });
  }
  return homes;
}

// ---- account -------------------------------------------------------------
//
// Neither source records the account in its logs, so this is the account
// logged in to that config dir NOW. Claude keeps it in .claude.json
// (oauthAccount.emailAddress): inside the config dir when CLAUDE_CONFIG_DIR
// is used, beside it (~/.claude.json) for the default. Codex keeps it in the
// id token of auth.json; only the email claim is read, and nothing else from
// that file is kept or printed. Read results are kept per file until its size
// or mtime changes, since ~/.claude.json is rewritten often but read every
// cycle.

const accountMemo = new Map<string, { size: number; mtimeMs: number; account: string }>();

async function readAccountFile(file: string, pick: (json: unknown) => string): Promise<string | undefined> {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return undefined;
  }
  const hit = accountMemo.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.account;
  let account = '';
  try {
    account = pick(JSON.parse(await fs.readFile(file, 'utf-8')));
  } catch {
    // Mid-write or malformed: no account this time.
  }
  accountMemo.set(file, { size: st.size, mtimeMs: st.mtimeMs, account });
  return account;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function claudeAccount(json: unknown): string {
  const acct = (json as { oauthAccount?: { emailAddress?: unknown } } | null)?.oauthAccount;
  return str(acct?.emailAddress);
}

function codexAccount(json: unknown): string {
  const token = (json as { tokens?: { id_token?: unknown } } | null)?.tokens?.id_token;
  if (typeof token !== 'string') return '';
  const payload = token.split('.')[1];
  if (!payload) return '';
  try {
    return str((JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as { email?: unknown }).email);
  } catch {
    return '';
  }
}

async function accountOf(source: Source, dir: string, isDefault: boolean): Promise<string> {
  if (source === 'codex') return (await readAccountFile(path.join(dir, 'auth.json'), codexAccount)) ?? '';
  const files = isDefault
    ? [path.join(path.dirname(dir), '.claude.json'), path.join(dir, '.claude.json')]
    : [path.join(dir, '.claude.json')];
  for (const f of files) {
    const a = await readAccountFile(f, claudeAccount);
    if (a !== undefined) return a;
  }
  return '';
}
