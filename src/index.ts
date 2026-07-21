#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs } from './lib/cli.js';
import { loadConfig, PACKAGE_ROOT, CONFIG_FILE_NAME, type CcxlogConfig } from './lib/config.js';
import { canonicalPath, canonicalPathString, fileIdentity, isPathWithin } from './lib/pathUtils.js';
import { assignCcxids, safeSessionId } from './lib/identity.js';
import { compareUnifiedPairs, dedupePairs, dedupeForkedSessions } from './lib/merge.js';
import { hasBothProgress, templateHasSource, unknownPlaceholders } from './lib/templates.js';
import {
  toUnifiedPair,
  formatPair,
  buildAggregatePreamble,
  buildSessionPreamble,
  planWrite,
  commitPlan,
  backupAndVerify,
  type WritePlan,
} from './lib/markdownWriter.js';
import {
  backupFolderName,
  backupJsonlFiles,
  listExportedMdFiles,
  backupMdFiles,
  parseSessionMarker,
  type JsonlBackupItem,
} from './lib/backup.js';
import { acquireLock, releaseLock, type LockHandle } from './lib/lock.js';
import { claudeAdapter } from './sources/claude/index.js';
import { codexAdapter } from './sources/codex/index.js';
import type { SourceAdapter, RootRef, DiscoveredFile, SessionData } from './sources/adapter.js';
import type { CliOptions, UnifiedPair, SourceMode } from './lib/types.js';

const PKG_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;

function adaptersForMode(mode: SourceMode): SourceAdapter[] {
  if (mode === 'claude') return [claudeAdapter];
  if (mode === 'codex') return [codexAdapter];
  return [claudeAdapter, codexAdapter];
}

const EXCLUDED_DIR_NAMES = new Set(['backup_jsonl', 'backup_CCXLOG_md', 'templates']);

// Transient OS errors that a retry can clear. Under load (many concurrent runs,
// antivirus scans, FD exhaustion) readdir/stat can briefly fail with these even
// though the directory is perfectly readable a moment later. Distinct from
// ENOENT/ENOTDIR, which are genuine "not there" answers we must not retry.
const TRANSIENT_FS_CODES = new Set(['EMFILE', 'ENFILE', 'EBUSY', 'EPERM', 'EACCES', 'EAGAIN']);

function isTransientFsError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code !== undefined && TRANSIENT_FS_CODES.has(code);
}

// Retry a filesystem probe a few times on transient errors before giving up.
// Silently swallowing a transient readdir failure would drop an ENTIRE log
// subtree with no warning (observed: deep Codex date trees vanish under load),
// so we back off and retry rather than treat a load spike as "empty".
async function fsRetry<T>(op: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 8;
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      if (attempt < MAX_ATTEMPTS && isTransientFsError(e)) {
        // Linear-ish backoff capped at 100ms: enough for FDs to free / an AV
        // scan to release the handle, without stalling a healthy run.
        await new Promise((r) => setTimeout(r, Math.min(100, 15 * (attempt + 1))));
        continue;
      }
      throw e;
    }
  }
}

async function walkJsonl(
  dir: string,
  recursive: boolean,
  outDir: string,
  visited: Set<string>,
): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await fsRetry(() => fs.readdir(dir, { withFileTypes: true }));
  } catch (e) {
    // A persistent failure (or a vanished dir): warn on anything but a plain
    // "not found" so a truly unreadable root is visible rather than silent.
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      console.warn(`Warning: could not read directory ${dir} (${code ?? 'unknown error'}); skipping it.`);
    }
    return [];
  }
  const results: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (isPathWithin(full, outDir) || full === outDir) continue;
    if (e.isDirectory()) {
      if (!recursive) continue;
      if (EXCLUDED_DIR_NAMES.has(e.name)) continue;
      const id = await fileIdentity(full);
      const key = id ? id.key : full;
      if (visited.has(key)) continue;
      visited.add(key);
      results.push(...await walkJsonl(full, recursive, outDir, visited));
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      results.push(full);
    }
  }
  return results;
}

async function discoverFiles(roots: RootRef[], outDir: string): Promise<DiscoveredFile[]> {
  const seenPhysical = new Set<string>();
  const out: DiscoveredFile[] = [];
  for (const root of roots) {
    let st;
    try { st = await fsRetry(() => fs.stat(root.dir)); } catch { continue; }
    if (!st.isDirectory()) continue;
    const visited = new Set<string>();
    const files = (await walkJsonl(root.dir, root.recursive, outDir, visited)).sort();
    for (const f of files) {
      const id = await fileIdentity(f);
      const key = id ? id.key : f;
      if (seenPhysical.has(key)) continue;
      seenPhysical.add(key);
      out.push({ filePath: f, root });
    }
  }
  return out;
}

// Validate namespace uniqueness of stableRootKeys within a source (§5.5).
function checkRootNamespaces(roots: RootRef[], sourceId: string, errors: string[]): void {
  const seen = new Map<string, string>();
  for (const r of roots) {
    if (r.origin !== 'extra') continue;
    const prev = seen.get(r.stableRootKey);
    if (prev !== undefined && prev !== r.dir) {
      errors.push(`Ambiguous ${sourceId} extraLogDirs namespace key "${r.stableRootKey}" maps to both ${prev} and ${r.dir}.`);
    }
    seen.set(r.stableRootKey, r.dir);
  }
}

interface AdapterRun {
  adapter: SourceAdapter;
  roots: RootRef[];
  files: DiscoveredFile[];
  sessions: SessionData[];   // filtered (belongs); pairs may be empty
}

async function run(opts: CliOptions): Promise<number> {
  const { config, errors: configErrors, warnings } = await loadConfig(opts.outDir, opts.projectPath);
  for (const w of warnings) console.warn(w);

  if (configErrors.length) {
    for (const e of configErrors) console.error(`Config error: ${e}`);
    if (!opts.dryRun) return EXIT_RUNTIME;
    console.error('(dry run) continuing with best-effort defaults.');
  }

  if (opts.initTemplate) {
    return initTemplate(opts, config);
  }

  const adapters = adaptersForMode(opts.mode);
  const realProjectPath = await resolveRealPath(opts.projectPath);

  // --backup-md: standalone, reads no jsonl (§9.4). Considers all 3 agg names.
  if (opts.backupMd) {
    const mdFiles = await listExportedMdFiles(opts.outDir, config);
    if (mdFiles.length === 0) {
      console.log('No files to back up.');
      return EXIT_OK;
    }
    const folder = backupFolderName(new Date());
    if (opts.dryRun) {
      console.log(`(dry run) would back up ${mdFiles.length} md file(s) to ${path.join(opts.outDir, 'backup_CCXLOG_md', folder)}`);
      for (const f of mdFiles) console.log(`  - ${path.basename(f)}`);
      return EXIT_OK;
    }
    const copied = await backupMdFiles(mdFiles, opts.outDir, folder, opts.verbose);
    console.log(`Backed up ${copied} md file(s).`);
    return EXIT_OK;
  }

  // Namespace validation for extra roots.
  const runErrors: string[] = [];
  const adapterRuns: AdapterRun[] = [];
  for (const adapter of adapters) {
    const roots = adapter.candidateRoots(opts.projectPath, realProjectPath, opts.outDir, config);
    // Nested-project roots (§ includeSubdirectories). Merge in the adapter's
    // subdir roots, dropping any whose dir already appears as a candidate root
    // (so a subdirectory that is ALSO an extraCwd is not discovered twice).
    if (config.includeSubdirectories && adapter.subdirRoots) {
      const seenDirs = new Set(roots.map(r => canonicalPathString(r.dir)));
      const extra = await adapter.subdirRoots(opts.projectPath, realProjectPath, config);
      for (const r of extra) {
        const key = canonicalPathString(r.dir);
        if (seenDirs.has(key)) continue;
        seenDirs.add(key);
        roots.push(r);
      }
    }
    checkRootNamespaces(roots, adapter.id, runErrors);
    adapterRuns.push({ adapter, roots, files: [], sessions: [] });
  }
  if (runErrors.length) {
    for (const e of runErrors) console.error(`Config error: ${e}`);
    return EXIT_RUNTIME;
  }

  // Discovery.
  for (const ar of adapterRuns) {
    ar.files = await discoverFiles(ar.roots, opts.outDir);
  }

  // Read + filter sessions.
  const wantedCwds = new Set(await Promise.all([opts.projectPath, ...config.extraCwds].map(canonicalPath)));
  const canonicalProjectPath = await canonicalPath(opts.projectPath);
  const filterCtx = {
    projectPath: opts.projectPath,
    wantedCwds,
    includeSubdirectories: config.includeSubdirectories,
    canonicalProjectPath,
  };
  for (const ar of adapterRuns) {
    const kept: SessionData[] = [];
    for (const f of ar.files) {
      const s = await ar.adapter.readSession(f, config);
      const { pairs, belongs } = await ar.adapter.filterSession(s, config, filterCtx);
      if (pairs.length > 0) kept.push({ ...s, allPairs: pairs });
      else if (belongs) kept.push({ ...s, allPairs: [] });
    }
    ar.sessions = kept;
  }

  if (opts.verbose) printVerbose(opts, config, adapterRuns);

  // --backup-jsonl: standalone (§9.5).
  if (opts.backupJsonl) {
    return backupJsonl(opts, adapterRuns);
  }

  // Build UnifiedPairs for each session (questionOrdinal = index in filtered pairs).
  const allPairs: UnifiedPair[] = [];
  const sessionUnified: SessionUnified[] = [];
  for (const ar of adapterRuns) {
    for (const s of ar.sessions) {
      const ups: UnifiedPair[] = s.allPairs.map((pair, i) => toUnifiedPair({
        pair,
        source: ar.adapter.id,
        sourceLabel: ar.adapter.label,
        sessionId: s.sessionId,
        sessionName: s.sessionName,
        sourceFile: s.jsonlPath,
        sourceFileRelativeId: s.sourceFileRelativeId,
        fileContentHash: s.fileContentHash,
        eventIdStreamHash: s.eventIdStreamHash,
        questionOrdinal: i,
      }));
      sessionUnified.push({ session: s, adapter: ar.adapter, pairs: ups });
      allPairs.push(...ups);
    }
  }
  assignCcxids(allPairs);

  // Template diagnostics (all modes).
  if (hasBothProgress(config.template)) {
    console.warn('Warning: template contains both %Progress% and %ProgressFull%; both will be filled.');
  }
  if (!templateHasSource(config.template)) {
    console.warn('Warning: template has no %Source%; source will be hard to tell apart in the output.');
  }
  if (opts.verbose) {
    const unknown = unknownPlaceholders(config.template);
    if (unknown.length) {
      console.warn(`Warning: template has unknown placeholder(s) left verbatim: ${unknown.map(n => `%${n}%`).join(', ')}.`);
    }
  }

  // Terminate condition (§3.3/§10-1): total adopted pairs == 0.
  if (allPairs.length === 0) {
    console.error('No pairs found for the selected source(s). Candidate log directories:');
    for (const ar of adapterRuns) {
      for (const r of ar.roots) console.error(`  - [${ar.adapter.id}] ${r.dir}`);
    }
    return EXIT_RUNTIME;
  }

  if (!opts.dryRun) await fs.mkdir(opts.outDir, { recursive: true });
  const mdBackupDir = path.join(opts.outDir, 'backup_CCXLOG_md', backupFolderName(new Date()));

  // Optional lock (§8.6).
  let lock: LockHandle | undefined;
  if (opts.lock && !opts.dryRun) {
    const res = await acquireLock(opts.outDir, opts.forceUnlock);
    if (res.error) { console.error(`Lock error: ${res.error}`); return EXIT_RUNTIME; }
    lock = res.handle;
  }
  try {
    if (opts.perSession) {
      return await writePerSession(opts, config, sessionUnified, mdBackupDir);
    }
    return await writeAggregate(opts, config, allPairs, sessionUnified, mdBackupDir);
  } finally {
    if (lock) await releaseLock(lock);
  }
}

async function writeAggregate(
  opts: CliOptions,
  config: CcxlogConfig,
  allPairs: UnifiedPair[],
  sessionUnified: SessionUnified[],
  mdBackupDir: string,
): Promise<number> {
  const sorted = [...allPairs].sort(compareUnifiedPairs);
  // Two-stage dedupe (§6.3): first the conservative per-session logical dedupe
  // (snapshots / prefixes / identical whole files), then the cross-session pass
  // that drops resumed/forked verbatim copies of the same turn by message uuid.
  const { kept: keptLogical, removed, possibleDuplicates } = dedupePairs(sorted);
  const { kept, removed: removedForks } = dedupeForkedSessions(keptLogical);

  const labelsPresent: string[] = [];
  if (kept.some(p => p.source === 'claude')) labelsPresent.push('ClaudeCode');
  if (kept.some(p => p.source === 'codex')) labelsPresent.push('Codex');

  const aggName = aggregateName(config, opts.mode);
  const preamble = buildAggregatePreamble(opts.mode, opts.projectPath, aggName, labelsPresent);
  const content = preamble + kept.map(p => formatPair(p, config.template)).join('');
  const filePath = path.join(opts.outDir, aggName);

  const planned = await planWrite(filePath, content, 'aggregate');
  if (!planned.ok) { console.error(`Error: ${planned.error}`); return EXIT_RUNTIME; }
  const plan = planned.plan;

  // Backup phase: take + verify the required backup before any write (§8.5).
  let backedUp = false;
  if (!opts.dryRun && plan.destructive) {
    if (!(await backupAndVerify(plan.filePath, mdBackupDir))) {
      console.error(`Error: backup failed for ${plan.filePath}; not overwriting.`);
      return EXIT_RUNTIME;
    }
    backedUp = true;
  }

  const commit = await commitPlan(plan, { dryRun: opts.dryRun, alreadyBackedUp: backedUp, backupDir: mdBackupDir });
  if (commit.error) { console.error(`Error: ${commit.error}`); return EXIT_RUNTIME; }

  console.log(`Mode: aggregate (${aggName}) [${opts.mode}]`);
  // Per-session result lines with unparseable counts, surfaced in aggregate mode
  // too (§3.3/§3.4) — not just per-session mode.
  for (const su of sessionUnified) {
    const idShort = su.session.sessionId.slice(0, 8);
    const skipNote = su.session.skippedLines ? ` [${su.session.skippedLines} unparseable lines]` : '';
    console.log(`[${su.adapter.id}:${idShort}] ${su.pairs.length} pair(s)${skipNote}`);
  }
  if (removed > 0) console.log(`De-duplicated ${removed} logical duplicate pair(s).`);
  if (removedForks > 0) console.log(`Removed ${removedForks} duplicate pair(s) from resumed/forked sessions.`);
  if (opts.verbose && possibleDuplicates > 0) {
    console.log(`Kept ${possibleDuplicates} possible duplicate pair(s) (same question key, not confirmed identical).`);
  }
  if (backedUp || (opts.dryRun && plan.destructive)) console.log(`Backed up 1 pre-overwrite md file to ${mdBackupDir}`);
  console.log(`Done. ${kept.length} pair(s) total [${commit.result}]${opts.dryRun ? ' (dry run)' : ''}.`);
  return EXIT_OK;
}

interface SessionUnified { session: SessionData; adapter: SourceAdapter; pairs: UnifiedPair[]; }

interface WriteTask { su: SessionUnified; filePath: string; fileName: string; content: string; }
interface DeleteTask { su: SessionUnified; filePath: string; }

async function writePerSession(
  opts: CliOptions,
  config: CcxlogConfig,
  sessionUnified: SessionUnified[],
  mdBackupDir: string,
): Promise<number> {
  const writeTasks: WriteTask[] = [];
  const deleteCandidates: DeleteTask[] = [];
  for (const su of sessionUnified) {
    const prefix = su.adapter.sessionFilePrefix(config);
    const fileName = `${prefix}${safeSessionId(su.session.sessionId, su.session.sourceFileRelativeId)}.md`;
    const filePath = path.join(opts.outDir, fileName);
    if (su.pairs.length === 0) { deleteCandidates.push({ su, filePath }); continue; }
    const sorted = [...su.pairs].sort(compareUnifiedPairs);
    const preamble = buildSessionPreamble(su.adapter.id, su.adapter.label, su.session.sessionId, su.session.jsonlPath, opts.projectPath);
    const content = preamble + sorted.map(p => formatPair(p, config.template)).join('');
    writeTasks.push({ su, filePath, fileName, content });
  }

  // Real filename collision across writes: two distinct sessions -> code 1
  // (§4.4/§8.4). On win32 the filesystem is case-insensitive, so fold case when
  // matching — otherwise cclog_ABC.md and cclog_abc.md would silently overwrite
  // each other (symmetric with the aggregate-name check in config.ts).
  const foldName = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const byName = new Map<string, WriteTask[]>();
  for (const t of writeTasks) {
    const key = foldName(t.fileName);
    const arr = byName.get(key);
    if (arr) arr.push(t); else byName.set(key, [t]);
  }
  for (const [, arr] of byName) {
    if (arr.length > 1) {
      console.error(`Error: per-session output name collision: ${arr.map(t => t.fileName).join(' / ')} produced by ${arr.length} sessions.`);
      return EXIT_RUNTIME;
    }
  }

  console.log(`Mode: per-session [${opts.mode}]`);

  // Plan all writes (§8.5 step 2). An ownership-unconfirmed target aborts.
  const plans: Array<{ task: WriteTask; plan: WritePlan }> = [];
  for (const t of writeTasks) {
    const pr = await planWrite(t.filePath, t.content, 'session');
    if (!pr.ok) { console.error(`Error: ${pr.error}`); return EXIT_RUNTIME; }
    plans.push({ task: t, plan: pr.plan });
  }

  // Plan deletions (§9.7): only files that satisfy every condition.
  const deletes: DeleteTask[] = [];
  for (const dc of deleteCandidates) {
    if (await sessionDeletable(dc.filePath, dc.su)) deletes.push(dc);
  }

  // Backup phase: destructive rewrites + deletions, all verified BEFORE any
  // write or delete (§8.5 step 3). Any failure aborts the whole run.
  const backedUpSet = new Set<string>();
  if (!opts.dryRun) {
    for (const { plan } of plans) {
      if (!plan.destructive) continue;
      if (!(await backupAndVerify(plan.filePath, mdBackupDir))) {
        console.error(`Error: backup failed for ${plan.filePath}; not writing anything.`);
        return EXIT_RUNTIME;
      }
      backedUpSet.add(plan.filePath);
    }
    for (const d of deletes) {
      if (!(await backupAndVerify(d.filePath, mdBackupDir))) {
        console.error(`Error: backup failed for ${d.filePath}; not writing anything.`);
        return EXIT_RUNTIME;
      }
      backedUpSet.add(d.filePath);
    }
  }

  // Commit phase (per-file re-check §8.5 step 4). File-level, not transactional.
  let totalPairs = 0;
  let backedUp = 0;
  let hadError = false;
  const updated: string[] = [];
  const notUpdated: string[] = [];

  for (const { task, plan } of plans) {
    const su = task.su;
    const idShort = su.session.sessionId.slice(0, 8);
    const skipNote = su.session.skippedLines ? ` [${su.session.skippedLines} unparseable lines]` : '';
    const commit = await commitPlan(plan, {
      dryRun: opts.dryRun,
      alreadyBackedUp: backedUpSet.has(plan.filePath),
      backupDir: mdBackupDir,
    });
    if (commit.error) {
      console.error(`Error: ${commit.error}`);
      notUpdated.push(task.fileName);
      hadError = true;
      continue;
    }
    if (backedUpSet.has(plan.filePath) || (opts.dryRun && plan.destructive)) backedUp++;
    totalPairs += su.pairs.length;
    if (commit.result !== 'noop') updated.push(task.fileName);
    console.log(`[${su.adapter.id}:${idShort}] ${su.pairs.length} pair(s) [${commit.result}]${skipNote}`);
  }

  // Deletions (already backed up above).
  const deletableSet = new Set(deletes.map(d => d.filePath));
  for (const d of deletes) {
    const idShort = d.su.session.sessionId.slice(0, 8);
    if (opts.dryRun) { console.log(`[${d.su.adapter.id}:${idShort}] 0 pair(s) (would remove file)`); continue; }
    try {
      await fs.unlink(d.filePath);
      updated.push(path.basename(d.filePath));
      console.log(`[${d.su.adapter.id}:${idShort}] 0 pair(s) (file removed)`);
    } catch {
      hadError = true;
      notUpdated.push(path.basename(d.filePath));
      console.log(`[${d.su.adapter.id}:${idShort}] 0 pair(s) (removal failed)`);
    }
  }
  for (const dc of deleteCandidates) {
    if (deletableSet.has(dc.filePath)) continue;
    const idShort = dc.su.session.sessionId.slice(0, 8);
    console.log(`[${dc.su.adapter.id}:${idShort}] 0 pair(s) (kept)`);
  }

  if (backedUp > 0) console.log(`Backed up ${backedUp} pre-overwrite md file(s) to ${mdBackupDir}`);
  if (hadError && updated.length > 0) {
    console.error(`Partial update: ${updated.length} written, ${notUpdated.length} left unchanged. Re-run to converge (§8.5).`);
    console.error(`  updated: ${updated.join(', ')}`);
    console.error(`  not updated: ${notUpdated.join(', ')}`);
  }
  console.log(`Done. ${totalPairs} pair(s) total${opts.dryRun ? ' (dry run)' : ''}.`);
  return hadError ? EXIT_RUNTIME : EXIT_OK;
}

// §9.7: a 0-pair session file may be deleted only when ALL conditions hold.
// Same source selected + session belongs (both true for anything in
// sessionUnified) + discovery/read succeeded (we read it) + new plan 0 pairs
// (caller only passes 0-pair sessions) + valid marker whose decoded id matches.
async function sessionDeletable(filePath: string, su: SessionUnified): Promise<boolean> {
  const marker = await parseSessionMarker(filePath);
  if (!marker) return false;                          // no valid marker / undecodable sid64
  if (marker.source !== su.adapter.id) return false;
  if (marker.sessionId !== su.session.sessionId) return false;
  return true;
}

async function backupJsonl(opts: CliOptions, adapterRuns: AdapterRun[]): Promise<number> {
  const items: JsonlBackupItem[] = [];
  for (const ar of adapterRuns) {
    // Claude: every discovered file belongs. Codex: only sessions that belong
    // (filterSession already kept only belonging sessions).
    const belongingPaths = new Set(ar.sessions.map(s => s.jsonlPath));
    for (const f of ar.files) {
      if (ar.adapter.id === 'codex' && !belongingPaths.has(f.filePath)) continue;
      items.push({
        filePath: f.filePath,
        source: ar.adapter.id,
        baseName: path.basename(f.filePath).replace(/\.jsonl$/, ''),
      });
    }
  }
  const folder = backupFolderName(new Date());
  if (opts.dryRun) {
    console.log(`(dry run) would back up ${items.length} jsonl file(s) to ${path.join(opts.outDir, 'backup_jsonl', folder)}`);
    return EXIT_OK;
  }
  await fs.mkdir(opts.outDir, { recursive: true });
  const copied = await backupJsonlFiles(items, opts.outDir, folder, opts.verbose);
  console.log(`Backed up ${copied} jsonl file(s).`);
  return EXIT_OK;
}

function aggregateName(config: CcxlogConfig, mode: SourceMode): string {
  if (mode === 'claude') return config.claude.outputAllFileName;
  if (mode === 'codex') return config.codex.outputAllFileName;
  return config.outputAllFileName;
}

async function resolveRealPath(p: string): Promise<string> {
  try { return await fs.realpath(p); } catch { return p; }
}

function printVerbose(opts: CliOptions, config: CcxlogConfig, adapterRuns: AdapterRun[]): void {
  console.log(`Project: ${opts.projectPath}`);
  console.log(`Out dir: ${opts.outDir}`);
  console.log(`Mode:    ${opts.mode}`);
  for (const ar of adapterRuns) {
    console.log(`[${ar.adapter.id}] roots:`);
    for (const r of ar.roots) console.log(`  ${r.origin === 'extra' ? '*' : '+'} ${r.dir}`);
    console.log(`[${ar.adapter.id}] files: ${ar.files.length}, sessions kept: ${ar.sessions.length}`);
  }
  void config;
}

// ---- --init-template (§7.4) ---------------------------------------------

async function initTemplate(opts: CliOptions, _config: CcxlogConfig): Promise<number> {
  const configPath = path.join(opts.outDir, CONFIG_FILE_NAME);
  let rawConfig: Record<string, unknown> = {};
  try {
    const text = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      rawConfig = parsed as Record<string, unknown>;
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Warning: could not read ${configPath}; starting with empty config.`);
    }
  }

  const currentTemplate = typeof rawConfig.template === 'string' && rawConfig.template.trim()
    ? rawConfig.template
    : 'templates/english.md';
  const baseName = path.basename(currentTemplate);
  const sourcePath = path.join(PACKAGE_ROOT, 'templates', baseName);

  try { await fs.stat(sourcePath); } catch {
    console.error(`Error: source template not found in ccxlog install: ${sourcePath}`);
    return EXIT_RUNTIME;
  }

  const destDir = path.join(opts.outDir, 'templates');
  const destPath = path.join(destDir, baseName);
  const newTemplate = `templates/${baseName}`;
  // Self-copy: when <out> IS the package root, dest and source are the same
  // file — §7.4 step 3 says reconcile the config only, without copying.
  const isSelfCopy = path.resolve(destPath) === path.resolve(sourcePath);
  const destExists = !isSelfCopy && await fs.stat(destPath).then(() => true, () => false);

  if (opts.dryRun) {
    if (destExists) { console.error(`Error: ${destPath} already exists.`); return EXIT_RUNTIME; }
    if (!isSelfCopy) console.log(`(dry run) would copy ${sourcePath} -> ${destPath}`);
    else console.log(`(dry run) dest is the source file itself; would set config only.`);
    console.log(`(dry run) would set template: "${newTemplate}"`);
    return EXIT_OK;
  }

  if (destExists) {
    console.error(`Error: ${destPath} already exists. Skipping copy.`);
    return EXIT_RUNTIME;
  }
  let copied = false;
  if (!isSelfCopy) {
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(sourcePath, destPath);
    copied = true;
    console.log(`Copied: ${sourcePath} -> ${destPath}`);
  }

  rawConfig.template = newTemplate;
  try {
    await writeConfigAtomic(configPath, rawConfig, opts.outDir);
  } catch (e: unknown) {
    // §7.4 step 5: on config-write failure, remove the newly-copied template so
    // the run leaves no half-applied state behind.
    if (copied) await fs.rm(destPath, { force: true });
    console.error(`Error: failed to update ${configPath}: ${(e as Error).message}`);
    return EXIT_RUNTIME;
  }
  console.log(`Updated: ${configPath} (template: "${newTemplate}")`);
  return EXIT_OK;
}

// Atomic config write per §8.2: same-dir temp with PID + crypto-random suffix,
// exclusive create (wx), fsync, then rename with a short EPERM/EACCES/EBUSY
// backoff. The temp is cleaned up if the rename ultimately fails.
async function writeConfigAtomic(configPath: string, obj: Record<string, unknown>, outDir: string): Promise<void> {
  await fs.mkdir(outDir, { recursive: true });
  const tmp = path.join(outDir, `.ccxlog.config.tmp-${process.pid}-${randomToken()}`);
  const body = JSON.stringify(obj, null, 2) + '\n';
  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(body, 'utf-8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rename(tmp, configPath);
      return;
    } catch (e: unknown) {
      lastErr = e;
      if (!transient.has((e as NodeJS.ErrnoException).code ?? '')) break;
      await new Promise(r => setTimeout(r, 20 * (attempt + 1)));
    }
  }
  await fs.rm(tmp, { force: true });
  throw lastErr;
}

function randomToken(): string {
  return crypto.randomBytes(8).toString('hex');
}

function printHelp(): void {
  console.log(`ccxlog - Merge Claude Code and Codex session logs into one Markdown timeline

Usage:
  ccxlog [project-path] [options]

Arguments:
  project-path           Project directory (defaults to the current directory).

Options:
  -cc, --claude-only     Claude Code logs only  -> CCXLOG/cclog.md
  -cx, --codex-only      Codex logs only        -> CCXLOG/cxlog.md
  --source <s>           Explicit form of the above: both|claude|codex (default both).
  --out <dir>            Output directory (default: <project-path>/CCXLOG).
  --per-session          Write one file per session (cclog_<id>.md / cxlog_<id>.md).
  --init-template        Copy the configured template into <out>/templates/ and
                         point the config at it.
  --backup-jsonl         Copy the discovered source .jsonl logs and exit.
  --backup-md            Copy the exported Markdown and exit.
  --lock                 Opt-in exclusive lock on <out> for the run.
  --force-unlock         Remove a stale lock (use with --lock).
  --dry-run              Report the plan without writing anything.
  --verbose              Verbose logging.
  -v, -V, --version      Show version and exit.
  -h, --help             Show this help.

Aggregate outputs (ccxlog.md / cclog.md / cxlog.md) coexist in <out>; each mode
only touches its own file. Progress rendering is controlled by the template
(%Progress% / %ProgressFull%).`);
}

async function main(): Promise<void> {
  const r = parseArgs(process.argv);
  if (r.kind === 'help') { printHelp(); return; }
  if (r.kind === 'version') { console.log(PKG_VERSION); return; }
  if (r.kind === 'error') {
    console.error(r.msg);
    printHelp();
    process.exitCode = EXIT_USAGE;
    return;
  }
  const code = await run(r.opts);
  process.exitCode = code;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exitCode = EXIT_RUNTIME;
});
