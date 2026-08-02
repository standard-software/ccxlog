import type { CcxlogConfig } from '../lib/config.js';
import type { FileSnapshot, PathDep } from '../lib/pathUtils.js';
import type { Pair, Source, SourceLabel } from '../lib/types.js';

// A discovery root and its stable namespace key (§5.5). `origin` is
// 'standard' (the source's default log tree) or 'extra' (an extraLogDirs
// entry). `stableRootKey` is 'std' for standard roots, and either the user
// alias or a hash of the canonical dir for extra roots.
export interface RootRef {
  dir: string;
  origin: 'standard' | 'extra';
  stableRootKey: string;
  recursive: boolean;
  // Claude only (when includeSidechain is on): also scan
  // subagents/*.jsonl under each session directory immediately below the root
  // — the separate-file layout Claude Code uses for subagent transcripts.
  scanSubagentDirs?: boolean;
}

export interface DiscoveredFile {
  filePath: string;
  root: RootRef;
  // size/mtimeMs/dev/ino as of discovery, i.e. before reading. Used for the
  // identity check of the incremental re-parse cache (lib/analysisCache.ts). A
  // file we failed to stat gets undefined, and is then never served from the
  // cache but always re-read — the safe direction.
  snapshot?: FileSnapshot;
}

export interface SessionData {
  source: Source;
  sessionId: string;
  sessionName: string;
  sessionCwd: string;
  jsonlPath: string;                 // display (absolute path)
  sourceFileRelativeId: string;      // namespaced stable id (§5.5)
  fromExplicitRoot: boolean;         // discovered under an extraLogDirs root (§5.2 trust)
  fileContentHash: () => Promise<string>;  // whole-file SHA-256 (lazy + memoised; §6.3 dedupe)
  eventIdStream: string[];           // stable event-id stream (raw strings; §6.3 subsequence check)
  allPairs: Pair[];
  skippedLines: number;
  formatRecognized: boolean;         // was a record of this source's own format seen? (§format detection, v1.5.0)
}

export interface FilterContext {
  projectPath: string;
  wantedCwds: Set<string>;           // canonical cwds ({project} ∪ extraCwds)
  includeSubdirectories: boolean;    // top-level cfg flag (default true)
  canonicalProjectPath: string;      // canonical(projectPath); subdir within-check base
}

// The result of the prefilter. For each excluded file it also reports which path
// resolutions the exclusion depended on. Even when a file's four attributes are
// unchanged, the incremental re-parse cache re-scans instead of reusing the
// outcome if those resolutions changed (lib/analysisCache.ts).
export interface PrefilterResult {
  /** Files not excluded, which go on to normal analysis (discovery order preserved). */
  passed: DiscoveredFile[];
  /** For each excluded file: filePath -> the cwd resolutions the verdict used. */
  excludedCwdDeps: Map<string, PathDep[]>;
}

// The result of belonging selection. `cwdDeps` is meaningful only when the
// session did NOT contribute to the output (zero pairs and belongs=false), where
// it hands the cwd resolutions behind that verdict to the incremental re-parse
// cache.
export interface FilterResult {
  pairs: Pair[];
  belongs: boolean;
  cwdDeps?: PathDep[];
}

export interface SourceAdapter {
  readonly id: Source;
  readonly label: SourceLabel;
  readonly shortLabel: 'cc' | 'cx';
  // `outDir` is the config-file location; relative extraLogDirs resolve
  // against it (§4.2), so the same config finds the same logs from any cwd.
  candidateRoots(projectPath: string, realProjectPath: string, outDir: string, cfg: CcxlogConfig): RootRef[];
  // Optional (§ includeSubdirectories): extra standard roots for projects
  // whose cwd is nested UNDER the target project. Claude implements this by
  // scanning ~/.claude/projects for prefix-matched folders and confirming each
  // one's real cwd; Codex has no per-project tree so leaves it unimplemented
  // (it widens its own cwd filter instead). Only called when
  // cfg.includeSubdirectories is true.
  subdirRoots?(projectPath: string, realProjectPath: string, cfg: CcxlogConfig): Promise<RootRef[]>;
  outputAllFileName(cfg: CcxlogConfig): string;
  sessionFilePrefix(cfg: CcxlogConfig): string;
  // Optional: a lightweight prefilter run before any session is fully parsed.
  // The only files it may exclude are those that CANNOT belong to the target
  // project; a file whose belonging is unknown must be kept and passed on to
  // normal analysis. The returned order must preserve discovery order so the
  // deterministic output order downstream is not disturbed.
  prefilterFiles?(
    files: DiscoveredFile[],
    cfg: CcxlogConfig,
    ctx: FilterContext,
  ): Promise<PrefilterResult>;
  readSession(file: DiscoveredFile, cfg: CcxlogConfig): Promise<SessionData>;
  // Optional mutable metadata pass. It runs every cycle after cached session
  // parsing, so metadata stored outside a rollout can change without forcing
  // the rollout itself through the parser again.
  refreshSessionMetadata?(sessions: SessionData[], roots: RootRef[]): Promise<SessionData[]>;
  // Keep only the pairs that belong to the target project. Returns the kept
  // pairs plus whether the session belongs to the project at all (used so
  // per-session mode can remove a stale file for an emptied session).
  filterSession(s: SessionData, cfg: CcxlogConfig, ctx: FilterContext): Promise<FilterResult>;
}
