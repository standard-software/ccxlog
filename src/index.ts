#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { parseArgs } from './lib/cli.js';
import { loadConfig, PACKAGE_ROOT, CONFIG_FILE_NAME, type CcxlogConfig } from './lib/config.js';
import {
  canonicalPath, canonicalPathString, clearCanonicalPathCache, fileIdentity, isPathWithin,
} from './lib/pathUtils.js';
import type { PathDep } from './lib/pathUtils.js';
import { assignCcxids, safeSessionId } from './lib/identity.js';
import { compareUnifiedPairs, dedupePairs, dedupeForkedSessions } from './lib/merge.js';
import { hasBothProgress, templateHasSource, unknownPlaceholders } from './lib/templates.js';
import { progressDataNeeded } from './lib/progressData.js';
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
  BACKUP_MD_AUTO_DIR,
  type JsonlBackupItem,
} from './lib/backup.js';
import { acquireLock, releaseLock, type LockHandle } from './lib/lock.js';
import { collectingSink, consoleSink, type OutputSink } from './lib/outputSink.js';
import {
  cacheKey, createAnalysisCache,
  type AnalysisCache, type CachedFile,
} from './lib/analysisCache.js';
import { DEFAULT_INTERVAL_SECONDS } from './lib/watchArgs.js';
import {
  createWatchLoop, emptyWriteCounts, formatSummary,
  type WatchCycleResult, type WriteCounts, type WriteKind,
} from './lib/watchRunner.js';
import { createWarningReporter, type WarningReporter } from './lib/watchWarnings.js';
import { claudeAdapter } from './sources/claude/index.js';
import { codexAdapter } from './sources/codex/index.js';
import type { SourceAdapter, RootRef, DiscoveredFile, SessionData, FilterContext } from './sources/adapter.js';
import type { CliOptions, UnifiedPair, SourceMode } from './lib/types.js';

const PKG_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;

// The result of one cycle (= one classic single run). The watch loop uses it
// for reporting and totals (§5.2). The output destination is passed as an
// argument to `run()` (an OutputSink) rather than being a module global: a
// single run keeps plain console (behaviour identical to before), while watch
// by default discards the detailed output and narrows it to one line per cycle
// that actually changed something (watch-spec §9.1).
interface RunOutcome {
  code: number;
  pairs: number;
  writes: WriteCounts;
  changed: boolean;
  changeLine?: string;
  writeLabel: string;
  failure?: string;
  intervalSeconds: number;
}

function outcome(fields: Partial<RunOutcome> & { code: number }): RunOutcome {
  return {
    pairs: 0,
    writes: emptyWriteCounts(),
    changed: false,
    writeLabel: 'none',
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    ...fields,
  };
}

const WRITE_KINDS: WriteKind[] = ['create', 'append', 'rewrite', 'noop'];

// A summary listing only the non-zero write kinds: `append` for a single kind
// with one file, `1 create, 2 append` for several (used by the --verbose cycle
// and cycle-result lines).
function describeWrites(w: WriteCounts, kinds: WriteKind[] = WRITE_KINDS): string {
  const present = kinds.filter(k => w[k] > 0);
  if (present.length === 0) return 'none';
  if (present.length === 1 && w[present[0]] === 1) return present[0];
  return present.map(k => `${w[k]} ${k}`).join(', ');
}

function adaptersForMode(mode: SourceMode): SourceAdapter[] {
  if (mode === 'claude') return [claudeAdapter];
  if (mode === 'codex') return [codexAdapter];
  return [claudeAdapter, codexAdapter];
}

// v1.5.0: this used to hold a guard that excluded everything under outDir, plus
// any directory named backup_jsonl / backup_CCXLOG_md / templates, from
// discovery. It was removed because (1) the .md backup directories contain no
// .jsonl, so excluding them achieved nothing, (2) backups never appear under the
// standard roots (~/.claude / ~/.codex), and (3) extraLogDirs is an explicit
// user choice, so reading it is exactly the intent. The one real problem —
// `--backup-jsonl` copying its own output back into itself — is prevented on the
// backup side by excluding the copy destination when choosing sources (see
// backupJsonl()), not on the discovery side.

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
  visited: Set<string>,
  out: OutputSink,
): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await fsRetry(() => fs.readdir(dir, { withFileTypes: true }));
  } catch (e) {
    // A persistent failure (or a vanished dir): warn on anything but a plain
    // "not found" so a truly unreadable root is visible rather than silent.
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      out.warn(`Warning: could not read directory ${dir} (${code ?? 'unknown error'}); skipping it.`);
    }
    return [];
  }
  const results: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!recursive) continue;
      const id = await fileIdentity(full);
      const key = id ? id.key : full;
      if (visited.has(key)) continue;
      visited.add(key);
      results.push(...await walkJsonl(full, recursive, visited, out));
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      results.push(full);
    }
  }
  return results;
}

// Discovery of subagent transcripts (§ includeSidechain, v1.5.0). Recent Claude
// Code versions store a subagent's conversation not as isSidechain entries
// inside the main session file but in a separate
// `<root>/<session id>/subagents/*.jsonl`. Only when includeSidechain is on, we
// additionally read what sits directly under subagents/ for each directory
// immediately below a root (no deeper recursion — the same reach as cclog).
async function listSubagentJsonl(rootDir: string, out: OutputSink): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await fsRetry(() => fs.readdir(rootDir, { withFileTypes: true }));
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(rootDir, e.name, 'subagents');
    let subEntries: Array<{ name: string; isFile(): boolean }>;
    try {
      subEntries = await fsRetry(() => fs.readdir(sub, { withFileTypes: true }));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        out.warn(`Warning: could not read directory ${sub} (${code ?? 'unknown error'}); skipping it.`);
      }
      continue;
    }
    for (const s of subEntries) {
      if (s.isFile() && s.name.endsWith('.jsonl')) found.push(path.join(sub, s.name));
    }
  }
  return found;
}

async function discoverFiles(roots: RootRef[], out: OutputSink): Promise<DiscoveredFile[]> {
  const seenPhysical = new Set<string>();
  const found: DiscoveredFile[] = [];
  for (const root of roots) {
    let st;
    try { st = await fsRetry(() => fs.stat(root.dir)); } catch { continue; }
    if (!st.isDirectory()) continue;
    const visited = new Set<string>();
    const files = (await walkJsonl(root.dir, root.recursive, visited, out)).sort();
    if (root.scanSubagentDirs) {
      files.push(...(await listSubagentJsonl(root.dir, out)).sort());
    }
    for (const f of files) {
      const id = await fileIdentity(f);
      const key = id ? id.key : f;
      if (seenPhysical.has(key)) continue;
      seenPhysical.add(key);
      // Carry the four attributes taken at discovery time (before reading).
      // The incremental re-parse cache decides identity from them; a file we
      // could not stat gets undefined, which means "always re-read".
      found.push({ filePath: f, root, snapshot: id?.snapshot });
    }
  }
  return found;
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
  filesRead: number;         // files that reached analysis after the prefilter (--verbose)
  // Incremental re-parse breakdown (--verbose). The two always sum to files.length.
  reparsed: number;          // discovered files re-scanned and re-read (cache miss)
  reused: number;            // discovered files taken straight from last cycle
  formatSkipped: string[];   // jsonl excluded for not being this source's format (--verbose)
  sessions: SessionData[];   // filtered (belongs); pairs may be empty
}

// Fingerprint of the "premises of the analysis" that must invalidate the
// incremental re-parse cache (analysisCache.ts). It folds in every input that
// could make the same file analyse differently. The config goes in whole rather
// than key by key: failing to enumerate a key that does affect analysis is worse
// than re-reading once too often because an irrelevant key changed.
function analysisFingerprint(config: CcxlogConfig, opts: CliOptions, ctx: FilterContext): string {
  return JSON.stringify({
    config,
    // Whether Progress data was retained is itself a "same file, different
    // analysis" condition, so it is folded in explicitly. `config` already
    // contains the template body, making this technically redundant today; it
    // stays a separate field so that narrowing the fingerprint later cannot
    // reintroduce the accident of reusing a slimmed session — read during a
    // no-reference cycle — in a cycle that does reference Progress.
    progressRetained: progressDataNeeded(config),
    mode: opts.mode,
    projectPath: ctx.projectPath,
    canonicalProjectPath: ctx.canonicalProjectPath,
    includeSubdirectories: ctx.includeSubdirectories,
    wantedCwds: [...ctx.wantedCwds].sort(),
  });
}

// One cycle's analysis (discovered files -> sessions). With a `cache`, a file
// whose four attributes match last cycle skips both the prefilter and the full
// parse and is reused. Without a cache (a single run) the path is exactly the
// classic one.
async function readAdapterSessions(
  ar: AdapterRun,
  config: CcxlogConfig,
  filterCtx: FilterContext,
  cache: AnalysisCache | undefined,
): Promise<void> {
  // 1. Consult the cache. Only files that missed go on to the prefilter and read.
  const hits = new Map<string, CachedFile>();
  const misses: DiscoveredFile[] = [];
  for (const f of ar.files) {
    const hit = await cache?.get(cacheKey(ar.adapter.id, f), f);
    if (hit) hits.set(f.filePath, hit); else misses.push(f);
  }
  ar.reused = hits.size;
  ar.reparsed = misses.length;

  // 2. The prefilter (currently implemented for Codex only) runs on the missed
  //    files alone. A hit reuses last cycle's "cannot belong" verdict. An
  //    excluded file also hands back the cwd resolutions its verdict depended
  //    on, which are stored alongside the cache entry as the material for
  //    checking next cycle whether the verdict may be reused.
  const prefiltered = ar.adapter.prefilterFiles
    ? await ar.adapter.prefilterFiles(misses, config, filterCtx)
    : { passed: misses, excludedCwdDeps: new Map<string, PathDep[]>() };
  const passedMisses = new Set(prefiltered.passed.map(f => f.filePath));

  // Belonging selection (filterSession) re-runs every cycle for as long as we
  // hold the raw session: it reads no disk, and caching it would only widen the
  // surface the invariant must be verified across. The return value says whether
  // the session contributed to the output and, when it did not, which cwd
  // resolutions the verdict depended on.
  const kept: SessionData[] = [];
  const takeFiltered = async (s: SessionData): Promise<{ used: boolean; cwdDeps: PathDep[] }> => {
    const { pairs, belongs, cwdDeps } = await ar.adapter.filterSession(s, config, filterCtx);
    if (pairs.length === 0 && !belongs) return { used: false, cwdDeps: cwdDeps ?? [] };
    kept.push({ ...s, allPairs: pairs });
    return { used: true, cwdDeps: [] };
  };

  // 3. Process one file at a time in discovery order (so the deterministic
  //    output order downstream is preserved). A hit reproduces last cycle's
  //    outcome verbatim; only a miss goes on to scan and read. `SessionData` is
  //    merely copied downstream, never mutated, so the cached instance can be
  //    shared as is.
  for (const f of ar.files) {
    const key = cacheKey(ar.adapter.id, f);
    const hit = hits.get(f.filePath);
    if (hit) {
      // A file the prefilter rejected was never even a candidate for the full
      // parse, so it is not counted as fully read. Everything else did reach the
      // full parse last cycle.
      if (hit.outcome === 'prefiltered') continue;
      ar.filesRead++;
      if (hit.outcome === 'unrecognized') { ar.formatSkipped.push(f.filePath); continue; }
      // 'dropped' means "read, but it does not belong to the target project".
      // We hold no raw data for it, so it is skipped as not contributing to the
      // output, exactly as last cycle.
      if (hit.outcome === 'used') await takeFiltered(hit.session);
      continue;
    }
    if (!passedMisses.has(f.filePath)) {
      await cache?.set(key, f, {
        outcome: 'prefiltered',
        pathDeps: prefiltered.excludedCwdDeps.get(f.filePath) ?? [],
      });
      continue;
    }
    ar.filesRead++;
    const s = await ar.adapter.readSession(f, config);
    // A file containing not one record of this source's own format (another
    // source's log, or an unrelated jsonl) is excluded as a source mismatch
    // (§format detection, v1.5.0).
    if (!s.formatRecognized) {
      ar.formatSkipped.push(f.filePath);
      await cache?.set(key, f, { outcome: 'unrecognized' });
      continue;
    }
    const r = await takeFiltered(s);
    // Only a session that contributed to the output carries its raw data
    // forward. The rest remember just the outcome and their cwd dependencies.
    await cache?.set(key, f, r.used
      ? { outcome: 'used', session: s }
      : { outcome: 'dropped', pathDeps: r.cwdDeps });
  }
  ar.sessions = kept;
}

async function run(
  opts: CliOptions,
  out: OutputSink = consoleSink,
  cache?: AnalysisCache,
): Promise<RunOutcome> {
  const { config, errors: configErrors, warnings } = await loadConfig(opts.outDir, opts.projectPath);
  for (const w of warnings) out.warn(w);

  // The value read during a cycle governs the wait that follows that cycle (§4.3).
  const intervalSeconds = config.watchIntervalSeconds;
  const fail = (msg: string): RunOutcome =>
    outcome({ code: EXIT_RUNTIME, failure: msg, intervalSeconds });
  const plain = (code: number): RunOutcome => outcome({ code, intervalSeconds });

  if (configErrors.length) {
    for (const e of configErrors) out.error(`Config error: ${e}`);
    // §4.3 decision table: "config turns fatal while running -> the wait after
    // that cycle is the default 5s". Corrupt JSON already gives 5s naturally,
    // because loadConfig returns early with the defaults; but when the JSON
    // parses and the error is fatal for another reason (a filename collision, a
    // template that cannot be resolved), watchIntervalSeconds has already been
    // assigned, so it is explicitly reset to the default here. This is NOT
    // "remember and substitute the last good value" — no state is kept.
    if (!opts.dryRun) {
      return outcome({
        code: EXIT_RUNTIME,
        failure: `Config error: ${configErrors[0]}`,
        intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      });
    }
    out.error('(dry run) continuing with best-effort defaults.');
  }

  if (opts.initTemplate) {
    return plain(await initTemplate(opts, config, out));
  }

  const adapters = adaptersForMode(opts.mode);
  const realProjectPath = await resolveRealPath(opts.projectPath);

  // --backup-md: standalone, reads no jsonl (§9.4). Considers all 3 agg names.
  if (opts.backupMd) {
    const mdFiles = await listExportedMdFiles(opts.outDir, config);
    if (mdFiles.length === 0) {
      out.log('No files to back up.');
      return plain(EXIT_OK);
    }
    const folder = backupFolderName(new Date());
    if (opts.dryRun) {
      out.log(`(dry run) would back up ${mdFiles.length} md file(s) to ${path.join(opts.outDir, 'backup_CCXLOG_md', folder)}`);
      for (const f of mdFiles) out.log(`  - ${path.basename(f)}`);
      return plain(EXIT_OK);
    }
    const copied = await backupMdFiles(mdFiles, opts.outDir, folder, opts.verbose);
    out.log(`Backed up ${copied} md file(s).`);
    return plain(EXIT_OK);
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
    adapterRuns.push({
      adapter, roots, files: [], filesRead: 0, reparsed: 0, reused: 0,
      formatSkipped: [], sessions: [],
    });
  }
  if (runErrors.length) {
    for (const e of runErrors) out.error(`Config error: ${e}`);
    return fail(`Config error: ${runErrors[0]}`);
  }

  // Discovery.
  for (const ar of adapterRuns) {
    ar.files = await discoverFiles(ar.roots, out);
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
  // Drop the whole cache if the premises of the analysis changed (a no-op otherwise).
  cache?.useFingerprint(analysisFingerprint(config, opts, filterCtx));
  for (const ar of adapterRuns) {
    await readAdapterSessions(ar, config, filterCtx, cache);
    if (ar.adapter.refreshSessionMetadata) {
      ar.sessions = await ar.adapter.refreshSessionMetadata(ar.sessions, ar.roots);
    }
  }
  // Discard entries for files that stopped being discovered (deleted or moved).
  cache?.endCycle();

  if (opts.verbose) printVerbose(opts, config, adapterRuns, out, cache);

  // --backup-jsonl: standalone (§9.5).
  if (opts.backupJsonl) {
    return plain(await backupJsonl(opts, adapterRuns, out));
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
        eventIdStream: s.eventIdStream,
        questionOrdinal: i,
      }));
      sessionUnified.push({ session: s, adapter: ar.adapter, pairs: ups });
      allPairs.push(...ups);
    }
  }
  assignCcxids(allPairs);

  // Template diagnostics (all modes).
  if (hasBothProgress(config.template)) {
    out.warn('Warning: template contains both %Progress% and %ProgressFull%; both will be filled.');
  }
  if (!templateHasSource(config.template)) {
    out.warn('Warning: template has no %Source%; source will be hard to tell apart in the output.');
  }
  if (opts.verbose) {
    const unknown = unknownPlaceholders(config.template);
    if (unknown.length) {
      out.warn(`Warning: template has unknown placeholder(s) left verbatim: ${unknown.map(n => `%${n}%`).join(', ')}.`);
    }
  }

  // Terminate condition (§3.3/§10-1): total adopted pairs == 0.
  // Under watch this is not a reason to stop but a failed cycle; once logs
  // appear, later cycles recover on their own (§10.1).
  if (allPairs.length === 0) {
    out.error('No pairs found for the selected source(s). Candidate log directories:');
    for (const ar of adapterRuns) {
      for (const r of ar.roots) out.error(`  - [${ar.adapter.id}] ${r.dir}`);
    }
    return fail('no pairs collected (no Claude Code / Codex sessions matched this project yet)');
  }

  if (!opts.dryRun) await fs.mkdir(opts.outDir, { recursive: true });
  const mdBackupDir = path.join(opts.outDir, BACKUP_MD_AUTO_DIR, backupFolderName(new Date()));
  // main() and runWatch() own the output lock for the complete operation.
  // run() must not acquire it again because watch cycles run under that lock.
  const r = opts.perSession
    ? await writePerSession(opts, config, sessionUnified, mdBackupDir, out)
    : await writeAggregate(opts, config, allPairs, sessionUnified, mdBackupDir, out);
  return { ...r, intervalSeconds };
}

async function writeAggregate(
  opts: CliOptions,
  config: CcxlogConfig,
  allPairs: UnifiedPair[],
  sessionUnified: SessionUnified[],
  mdBackupDir: string,
  out: OutputSink,
): Promise<RunOutcome> {
  const sorted = [...allPairs].sort(compareUnifiedPairs);
  // Two-stage dedupe (§6.3): first the conservative per-session logical dedupe
  // (snapshots / prefixes / identical whole files), then the cross-session pass
  // that drops resumed/forked verbatim copies of the same turn by message uuid.
  const { kept: keptLogical, removed, possibleDuplicates } = await dedupePairs(sorted);
  const { kept, removed: removedForks } = dedupeForkedSessions(keptLogical);

  const labelsPresent: string[] = [];
  if (kept.some(p => p.source === 'claude')) labelsPresent.push('ClaudeCode');
  if (kept.some(p => p.source === 'codex')) labelsPresent.push('Codex');

  const aggName = aggregateName(config, opts.mode);
  const preamble = buildAggregatePreamble(opts.mode, opts.projectPath, aggName, labelsPresent);
  const content = preamble + kept.map(p => formatPair(p, config.template)).join('');
  const filePath = path.join(opts.outDir, aggName);

  const planned = await planWrite(filePath, content, 'aggregate');
  if (!planned.ok) { out.error(`Error: ${planned.error}`); return outcome({ code: EXIT_RUNTIME, failure: planned.error }); }
  const plan = planned.plan;

  // Backup phase: take + verify the required backup before any write (§8.5).
  let backedUp = false;
  if (!opts.dryRun && plan.backupRequired) {
    if (!(await backupAndVerify(plan.filePath, mdBackupDir))) {
      out.error(`Error: backup failed for ${plan.filePath}; not overwriting.`);
      return outcome({ code: EXIT_RUNTIME, failure: `backup failed for ${plan.filePath}; not overwriting.` });
    }
    backedUp = true;
  }

  const commit = await commitPlan(plan, { dryRun: opts.dryRun, alreadyBackedUp: backedUp, backupDir: mdBackupDir });
  if (commit.error) { out.error(`Error: ${commit.error}`); return outcome({ code: EXIT_RUNTIME, failure: commit.error }); }

  out.log(`Mode: aggregate (${aggName}) [${opts.mode}]`);
  // Per-session result lines with unparseable counts, surfaced in aggregate mode
  // too (§3.3/§3.4) — not just per-session mode.
  for (const su of sessionUnified) {
    const idShort = su.session.sessionId.slice(0, 8);
    const skipNote = su.session.skippedLines ? ` [${su.session.skippedLines} unparseable lines]` : '';
    out.log(`[${su.adapter.id}:${idShort}] ${su.pairs.length} pair(s)${skipNote}`);
  }
  if (removed > 0) out.log(`De-duplicated ${removed} logical duplicate pair(s).`);
  if (removedForks > 0) out.log(`Removed ${removedForks} duplicate pair(s) from resumed/forked sessions.`);
  if (opts.verbose && possibleDuplicates > 0) {
    out.log(`Kept ${possibleDuplicates} possible duplicate pair(s) (same question key, not confirmed identical).`);
  }
  const reportBackup = backedUp || (opts.dryRun && plan.backupRequired);
  if (reportBackup) out.log(`Backed up 1 pre-overwrite md file to ${mdBackupDir}`);
  out.log(`Done. ${kept.length} pair(s) total [${commit.result}]${opts.dryRun ? ' (dry run)' : ''}.`);

  const writes = emptyWriteCounts();
  writes[commit.result]++;
  return outcome({
    code: EXIT_OK,
    pairs: kept.length,
    writes,
    changed: commit.result !== 'noop',
    changeLine: `${kept.length} pair(s) [${commit.result}]${reportBackup ? ' (backed up 1 file)' : ''}`,
    writeLabel: commit.result,
  });
}

interface SessionUnified { session: SessionData; adapter: SourceAdapter; pairs: UnifiedPair[]; }

interface WriteTask { su: SessionUnified; filePath: string; fileName: string; content: string; }
interface DeleteTask { su: SessionUnified; filePath: string; }

async function writePerSession(
  opts: CliOptions,
  config: CcxlogConfig,
  sessionUnified: SessionUnified[],
  mdBackupDir: string,
  out: OutputSink,
): Promise<RunOutcome> {
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
      const msg = `per-session output name collision: ${arr.map(t => t.fileName).join(' / ')} produced by ${arr.length} sessions.`;
      out.error(`Error: ${msg}`);
      return outcome({ code: EXIT_RUNTIME, failure: msg });
    }
  }

  out.log(`Mode: per-session [${opts.mode}]`);

  // Plan all writes (§8.5 step 2). An ownership-unconfirmed target aborts.
  const plans: Array<{ task: WriteTask; plan: WritePlan }> = [];
  for (const t of writeTasks) {
    const pr = await planWrite(t.filePath, t.content, 'session');
    if (!pr.ok) { out.error(`Error: ${pr.error}`); return outcome({ code: EXIT_RUNTIME, failure: pr.error }); }
    plans.push({ task: t, plan: pr.plan });
  }

  // Plan deletions (§9.7): only files that satisfy every condition.
  const deletes: DeleteTask[] = [];
  for (const dc of deleteCandidates) {
    if (await sessionDeletable(dc.filePath, dc.su)) deletes.push(dc);
  }

  // Backup stage: every rewrite marked backupRequired (only when ccxlogid is
  // lost, v1.4.0 R2) plus every file deletion (equivalent to losing all ids) is
  // taken and verified BEFORE any write or delete happens (§8.5 step 3). A
  // single failure aborts the entire run.
  const backedUpSet = new Set<string>();
  if (!opts.dryRun) {
    for (const { plan } of plans) {
      if (!plan.backupRequired) continue;
      if (!(await backupAndVerify(plan.filePath, mdBackupDir))) {
        const msg = `backup failed for ${plan.filePath}; not writing anything.`;
        out.error(`Error: ${msg}`);
        return outcome({ code: EXIT_RUNTIME, failure: msg });
      }
      backedUpSet.add(plan.filePath);
    }
    for (const d of deletes) {
      if (!(await backupAndVerify(d.filePath, mdBackupDir))) {
        const msg = `backup failed for ${d.filePath}; not writing anything.`;
        out.error(`Error: ${msg}`);
        return outcome({ code: EXIT_RUNTIME, failure: msg });
      }
      backedUpSet.add(d.filePath);
    }
  }

  // Commit phase (per-file re-check §8.5 step 4). File-level, not transactional.
  let totalPairs = 0;
  let backedUp = 0;
  let hadError = false;
  let removedFiles = 0;
  const writes = emptyWriteCounts();
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
      out.error(`Error: ${commit.error}`);
      notUpdated.push(task.fileName);
      hadError = true;
      continue;
    }
    if (backedUpSet.has(plan.filePath) || (opts.dryRun && plan.backupRequired)) backedUp++;
    totalPairs += su.pairs.length;
    writes[commit.result]++;
    if (commit.result !== 'noop') updated.push(task.fileName);
    out.log(`[${su.adapter.id}:${idShort}] ${su.pairs.length} pair(s) [${commit.result}]${skipNote}`);
  }

  // Deletions (already backed up above).
  const deletableSet = new Set(deletes.map(d => d.filePath));
  for (const d of deletes) {
    const idShort = d.su.session.sessionId.slice(0, 8);
    if (opts.dryRun) {
      removedFiles++;
      out.log(`[${d.su.adapter.id}:${idShort}] 0 pair(s) (would remove file)`);
      continue;
    }
    try {
      await fs.unlink(d.filePath);
      removedFiles++;
      updated.push(path.basename(d.filePath));
      out.log(`[${d.su.adapter.id}:${idShort}] 0 pair(s) (file removed)`);
    } catch {
      hadError = true;
      notUpdated.push(path.basename(d.filePath));
      out.log(`[${d.su.adapter.id}:${idShort}] 0 pair(s) (removal failed)`);
    }
  }
  for (const dc of deleteCandidates) {
    if (deletableSet.has(dc.filePath)) continue;
    const idShort = dc.su.session.sessionId.slice(0, 8);
    out.log(`[${dc.su.adapter.id}:${idShort}] 0 pair(s) (kept)`);
  }

  if (backedUp > 0) out.log(`Backed up ${backedUp} pre-overwrite md file(s) to ${mdBackupDir}`);
  if (hadError && updated.length > 0) {
    out.error(`Partial update: ${updated.length} written, ${notUpdated.length} left unchanged. Re-run to converge (§8.5).`);
    out.error(`  updated: ${updated.join(', ')}`);
    out.error(`  not updated: ${notUpdated.join(', ')}`);
  }
  out.log(`Done. ${totalPairs} pair(s) total${opts.dryRun ? ' (dry run)' : ''}.`);

  const changedKinds = describeWrites(writes, ['create', 'append', 'rewrite']);
  const changed = changedKinds !== 'none' || removedFiles > 0;
  const extra = (removedFiles > 0 ? ` (removed ${removedFiles} file(s))` : '')
    + (backedUp > 0 ? ` (backed up ${backedUp} file(s))` : '');
  return outcome({
    code: hadError ? EXIT_RUNTIME : EXIT_OK,
    failure: hadError ? `per-session update incomplete: ${notUpdated.join(', ')} left unchanged` : undefined,
    pairs: totalPairs,
    writes,
    changed,
    changeLine: `${totalPairs} pair(s) [${changedKinds === 'none' ? 'noop' : changedKinds}]${extra}`,
    writeLabel: describeWrites(writes),
  });
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

async function backupJsonl(opts: CliOptions, adapterRuns: AdapterRun[], out: OutputSink): Promise<number> {
  const items: JsonlBackupItem[] = [];
  // Self-propagation guard (v1.5.0): even when extraLogDirs points somewhere
  // that contains the copy destination (<out>/backup_jsonl), files already under
  // that destination are never used as copy sources. Reading (Markdown output)
  // is unaffected; this only stops each backup from duplicating earlier backups
  // and growing without bound.
  const backupRoot = path.join(opts.outDir, 'backup_jsonl');
  for (const ar of adapterRuns) {
    // Both sources back up only files that were recognized as their own format
    // and accepted by filterSession.  In particular, a mixed extraLogDirs root
    // must not copy Codex/junk JSONL into cc/ (or Claude/junk JSONL into cx/).
    const belongingPaths = new Set(ar.sessions.map(s => s.jsonlPath));
    const added = new Set<string>();
    for (const f of ar.files) {
      if (!belongingPaths.has(f.filePath)) continue;
      if (isPathWithin(f.filePath, backupRoot)) continue;
      added.add(f.filePath);
      items.push({
        filePath: f.filePath,
        source: ar.adapter.id,
        relPath: path.relative(f.root.dir, f.filePath),
      });
    }
    // Claude subagent transcripts are always included in a backup regardless of
    // the includeSidechain setting (v1.5.0): whether to DISPLAY them and whether
    // to PRESERVE the logs are separate questions.
    if (ar.adapter.id === 'claude') {
      for (const root of ar.roots) {
        for (const f of await listSubagentJsonl(root.dir, out)) {
          if (added.has(f) || isPathWithin(f, backupRoot)) continue;
          added.add(f);
          items.push({ filePath: f, source: 'claude', relPath: path.relative(root.dir, f) });
        }
      }
    }
  }
  const folder = backupFolderName(new Date());
  if (opts.dryRun) {
    out.log(`(dry run) would back up ${items.length} jsonl file(s) to ${path.join(opts.outDir, 'backup_jsonl', folder)}`);
    return EXIT_OK;
  }
  await fs.mkdir(opts.outDir, { recursive: true });
  const copied = await backupJsonlFiles(items, opts.outDir, folder, opts.verbose);
  out.log(`Backed up ${copied} jsonl file(s).`);
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

function printVerbose(
  opts: CliOptions,
  config: CcxlogConfig,
  adapterRuns: AdapterRun[],
  out: OutputSink,
  cache: AnalysisCache | undefined,
): void {
  out.log(`Project: ${opts.projectPath}`);
  out.log(`Out dir: ${opts.outDir}`);
  out.log(`Mode:    ${opts.mode}`);
  if (cache) {
    // `fully read` counts the files that became candidates for a full parse, NOT
    // the files actually read from disk this cycle. On a cycle where the
    // incremental re-parse took effect, last cycle's analysis is reused and only
    // `reparsed` files were truly read. The same explanation appears in the
    // --watch section of the README.
    out.log('  (fully read = files analysed this cycle; reparsed = files actually re-read from disk)');
  }
  for (const ar of adapterRuns) {
    out.log(`[${ar.adapter.id}] roots:`);
    for (const r of ar.roots) out.log(`  ${r.origin === 'extra' ? '*' : '+'} ${r.dir}`);
    out.log(`[${ar.adapter.id}] files: ${ar.files.length}, fully read: ${ar.filesRead}, sessions kept: ${ar.sessions.length}`
      // The breakdown is added only on a run where watch's incremental re-parse is active.
      + (cache ? `, reparsed: ${ar.reparsed}, reused: ${ar.reused}` : '')
      + (ar.formatSkipped.length > 0 ? `, format-skipped: ${ar.formatSkipped.length}` : ''));
    for (const f of ar.formatSkipped) out.log(`  skipped (not ${ar.adapter.id}-format): ${f}`);
  }
  void config;
}

// ---- --init-template (§7.4) ---------------------------------------------

async function initTemplate(opts: CliOptions, _config: CcxlogConfig, out: OutputSink): Promise<number> {
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
      out.warn(`Warning: could not read ${configPath}; starting with empty config.`);
    }
  }

  const currentTemplate = typeof rawConfig.template === 'string' && rawConfig.template.trim()
    ? rawConfig.template
    : 'templates/english.md';
  const baseName = path.basename(currentTemplate);
  const sourcePath = path.join(PACKAGE_ROOT, 'templates', baseName);

  try { await fs.stat(sourcePath); } catch {
    out.error(`Error: source template not found in ccxlog install: ${sourcePath}`);
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
    if (destExists) { out.error(`Error: ${destPath} already exists.`); return EXIT_RUNTIME; }
    if (!isSelfCopy) out.log(`(dry run) would copy ${sourcePath} -> ${destPath}`);
    else out.log(`(dry run) dest is the source file itself; would set config only.`);
    out.log(`(dry run) would set template: "${newTemplate}"`);
    return EXIT_OK;
  }

  if (destExists) {
    out.error(`Error: ${destPath} already exists. Skipping copy.`);
    return EXIT_RUNTIME;
  }
  let copied = false;
  if (!isSelfCopy) {
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(sourcePath, destPath);
    copied = true;
    out.log(`Copied: ${sourcePath} -> ${destPath}`);
  }

  rawConfig.template = newTemplate;
  try {
    await writeConfigAtomic(configPath, rawConfig, opts.outDir);
  } catch (e: unknown) {
    // §7.4 step 5: on config-write failure, remove the newly-copied template so
    // the run leaves no half-applied state behind.
    if (copied) await fs.rm(destPath, { force: true });
    out.error(`Error: failed to update ${configPath}: ${(e as Error).message}`);
    return EXIT_RUNTIME;
  }
  out.log(`Updated: ${configPath} (template: "${newTemplate}")`);
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
  -cc                    Claude Code logs only (default output: cclog.md).
  -cx                    Codex logs only (default output: cxlog.md).
  --out <dir>            Output directory (default: <project-path>/CCXLOG).
  --per-session          Write one file per session (cclog_<id>.md / cxlog_<id>.md).
  --init-template        Copy the configured template into <out>/templates/ and
                         point the config at it.
  --backup-jsonl         Copy the discovered source .jsonl logs and exit.
  --backup-md            Copy the exported Markdown and exit.
  --lock                 Explicitly request the output lock (write operations
                         and --watch lock automatically; kept for compatibility).
  --force-unlock         Remove a stale lock (use with --lock).
  --watch                Run repeatedly: process, wait N seconds, process again
                         (N = watchIntervalSeconds in ccxlog.config.json;
                         default 5).
  --watch=<n><unit>      Same, but stop after the given duration from start
                         (positive integer + one unit s/m/h/d; e.g.
                         --watch=60s). A number without a unit is an error.
  --dry-run              Report the plan without writing anything.
  --verbose              Verbose logging.
  -v, -V, --version      Show version and exit.
  -h, --help             Show this help.

Output filenames are configurable in <out>/ccxlog.config.json:
  outputAllFileName         merged output (default: ccxlog.md)
  claude.outputAllFileName  -cc output     (default: cclog.md)
  codex.outputAllFileName   -cx output     (default: cxlog.md)
  watchIntervalSeconds      --watch wait    (default: 5, range 1-86400)

The three aggregate outputs coexist in <out>; each mode only touches its own
file. Progress rendering is controlled by the template (%Progress% /
%ProgressFull%).`);
}

// ---- --watch (§5, §9, §10) -----------------------------------------------

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Consecutive-warning suppression within a cycle lives in `lib/watchWarnings.ts`
// (§4.2 / §9.3). It is a separate unit with an injectable clock source so tests
// can prove that wall-clock jumps do not break the suppression.

// A fault-injection seam (§11.1). It exists only so a cycle can be made reliably
// long enough to create the "cycle in progress" state deterministically
// (acceptance tests F-42 / E43). Unset means 0.
function testCycleDelayMs(): number {
  const raw = process.env.CCXLOG_WATCH_TEST_CYCLE_DELAY_MS;
  const n = raw === undefined ? 0 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function runWatch(opts: CliOptions): Promise<number> {
  // 1-2. Arguments are already parsed. Resolve project / out and load the config
  // (a fatal error is exit code 1; --dry-run warns and continues, exactly as in a
  // single run — §4.3).
  let pre;
  try {
    pre = await loadConfig(opts.outDir, opts.projectPath);
  } catch (e) {
    console.error(`Config error: ${errorMessage(e)}`);
    return EXIT_RUNTIME;
  }
  for (const w of pre.warnings) console.warn(w);
  if (pre.errors.length) {
    for (const e of pre.errors) console.error(`Config error: ${e}`);
    if (!opts.dryRun) return EXIT_RUNTIME;
    console.error('(dry run) continuing with best-effort defaults.');
  }

  const canonProject = await canonicalPath(opts.projectPath);
  const canonOut = await canonicalPath(opts.outDir);

  const warningReporter = createWarningReporter(consoleSink);
  // Warnings emitted at startup carry over as the initial state, so the same bad
  // setting is not immediately repeated on cycle 1 (the point of the
  // consecutive-warning suppression in §4.2).
  warningReporter.prime(pre.warnings);
  const cycleDelayMs = testCycleDelayMs();
  // The incremental re-parse cache. It lives only for the watch process and
  // never touches disk, so cycle 1 starts empty — a classic cold run.
  const cache = createAnalysisCache();
  // runWatch() owns the lifetime lock, so individual cycles must not reacquire it.
  const cycleOpts: CliOptions = { ...opts, lock: false, forceUnlock: false };
  const loop = createWatchLoop({
    durationSeconds: opts.watchDurationSeconds,
    verbose: opts.verbose,
    out: consoleSink,
    cycle: () => runCycle(cycleOpts, warningReporter, cycleDelayMs, cache),
  });

  // Prevent competing watches and one-shot writes for the full watch lifetime,
  // including waits between cycles. A dry run preserves its no-write contract.
  let watchLock: LockHandle | undefined;
  if (!opts.dryRun) {
    await fs.mkdir(opts.outDir, { recursive: true });
    const res = await acquireLock(opts.outDir, false);
    if (res.error) {
      // acquireLock's message ends with "Re-run with --force-unlock", which a
      // watch cannot do (--watch and --force-unlock are mutually exclusive,
      // §3.5). Point at the one-shot command that actually clears it instead, so
      // the guidance is something the user can carry out.
      console.error(`Lock error: ${res.error.replace(
        ' Re-run with --force-unlock to remove it manually.',
        ' A watch cannot force-unlock; clear it first with: ccxlog --lock --force-unlock',
      )}`);
      return EXIT_RUNTIME;
    }
    watchLock = res.handle;
  }

  // 3. Signal handlers (§10.2). SIGTERM is POSIX-only.
  let sigintCount = 0;
  const onSigint = () => {
    sigintCount++;
    // The second one quits immediately, with no grace period. Even mid-write,
    // the existing atomic commit (temp + rename) keeps the output file intact.
    if (sigintCount >= 2) process.exit(130);
    if (loop.isProcessing()) {
      console.error('Stopping after the current cycle... (press Ctrl+C again to force quit)');
    }
    loop.requestStop('sigint');
  };
  const onSigterm = () => loop.requestStop('sigterm');
  process.on('SIGINT', onSigint);
  if (process.platform !== 'win32') process.on('SIGTERM', onSigterm);

  // Print the banner and run the loop while holding the lifetime lock.
  let summary;
  try {
    const durationLabel = opts.watchDurationSeconds === null ? 'unlimited' : `${opts.watchDurationSeconds}s`;
    const killHint = process.platform === 'win32' ? `taskkill /F /PID ${process.pid}` : `kill ${process.pid}`;
    console.log(`ccxlog watch started (pid ${process.pid}): interval ${pre.config.watchIntervalSeconds}s`
      + `, duration ${durationLabel}, mode ${opts.mode}${opts.dryRun ? ' (dry run)' : ''}`);
    console.log(`  project: ${canonProject}`);
    console.log(opts.perSession
      ? `  output:  per-session files in ${canonOut}`
      : `  output:  ${path.join(canonOut, aggregateName(pre.config, opts.mode))}`);
    console.log(`Press Ctrl+C to stop, or terminate pid ${process.pid} from another terminal (e.g. ${killHint}).`);
    summary = await loop.run();
  } finally {
    process.off('SIGINT', onSigint);
    if (process.platform !== 'win32') process.off('SIGTERM', onSigterm);
    if (watchLock) await releaseLock(watchLock);
  }

  for (const line of formatSummary(summary)) console.log(line);
  return summary.exitCode;
}

async function runCycle(
  opts: CliOptions,
  warningReporter: WarningReporter,
  delayMs: number,
  cache: AnalysisCache,
): Promise<WatchCycleResult> {
  const warnings: string[] = [];
  const sink = opts.verbose ? consoleSink : collectingSink(warnings);
  cache.beginCycle();
  clearCanonicalPathCache();
  try {
    const r = await run(opts, sink, cache);
    if (delayMs > 0) await delay(delayMs);
    if (!opts.verbose) warningReporter.report(warnings);
    return {
      ok: r.code === EXIT_OK,
      failure: r.failure,
      pairs: r.pairs,
      writes: r.writes,
      changed: r.changed,
      changeLine: r.changeLine,
      writeLabel: r.writeLabel,
      intervalSeconds: r.intervalSeconds,
      cache: cache.stats(),
    };
  } catch (e) {
    if (opts.verbose && e instanceof Error && e.stack) console.error(e.stack);
    if (!opts.verbose) warningReporter.report(warnings);
    return {
      ok: false,
      failure: errorMessage(e),
      pairs: 0,
      writes: emptyWriteCounts(),
      changed: false,
      writeLabel: 'none',
      intervalSeconds: DEFAULT_INTERVAL_SECONDS,
      cache: cache.stats(),
    };
  }
}

// One-shot operations use the same output lock. Therefore a regular ccxlog
// command fails before writing while a watch owns the output directory.
async function runOnceWithLock(opts: CliOptions): Promise<RunOutcome> {
  if (opts.dryRun) return await run(opts);

  await fs.mkdir(opts.outDir, { recursive: true });
  const res = await acquireLock(opts.outDir, opts.forceUnlock);
  if (res.error || !res.handle) {
    const msg = res.error ?? `Could not acquire lock in ${opts.outDir}`;
    console.error(`Lock error: ${msg}`);
    return outcome({ code: EXIT_RUNTIME, failure: `Lock error: ${msg}` });
  }
  try {
    return await run({ ...opts, lock: false, forceUnlock: false });
  } finally {
    await releaseLock(res.handle);
  }
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
  if (r.opts.watch) {
    process.exitCode = await runWatch(r.opts);
    return;
  }
  const res = await runOnceWithLock(r.opts);
  process.exitCode = res.code;
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exitCode = EXIT_RUNTIME;
});
