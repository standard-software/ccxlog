import type { CcxlogConfig } from '../lib/config.js';
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
}

export interface DiscoveredFile {
  filePath: string;
  root: RootRef;
}

export interface SessionData {
  source: Source;
  sessionId: string;
  sessionName: string;
  sessionCwd: string;
  jsonlPath: string;                 // display (absolute path)
  sourceFileRelativeId: string;      // namespaced stable id (§5.5)
  fromExplicitRoot: boolean;         // discovered under an extraLogDirs root (§5.2 trust)
  fileContentHash: string;           // whole-file SHA-256 (dedupe §6.3)
  eventIdStreamHash: string[];       // stable event id stream (subsequence §6.3)
  allPairs: Pair[];
  skippedLines: number;
}

export interface FilterContext {
  projectPath: string;
  wantedCwds: Set<string>;           // canonical cwds ({project} ∪ extraCwds)
  includeSubdirectories: boolean;    // top-level cfg flag (default true)
  canonicalProjectPath: string;      // canonical(projectPath); subdir within-check base
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
  readSession(file: DiscoveredFile, cfg: CcxlogConfig): Promise<SessionData>;
  // Keep only the pairs that belong to the target project. Returns the kept
  // pairs plus whether the session belongs to the project at all (used so
  // per-session mode can remove a stale file for an emptied session).
  filterSession(s: SessionData, cfg: CcxlogConfig, ctx: FilterContext): Promise<{ pairs: Pair[]; belongs: boolean }>;
}
