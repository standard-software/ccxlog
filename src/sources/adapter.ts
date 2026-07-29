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
  // Claude 専用（includeSidechain 有効時）: ルート直下の各セッションディレクトリの
  // subagents/*.jsonl（サブエージェント記録の別ファイルレイアウト）も探索する
  scanSubagentDirs?: boolean;
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
  fileContentHash: () => Promise<string>;  // 全ファイル SHA-256（遅延・メモ化。§6.3 重複排除）
  eventIdStream: string[];           // 安定イベントID列（生文字列。§6.3 サブシーケンス確認）
  allPairs: Pair[];
  skippedLines: number;
  formatRecognized: boolean;         // 自ソース形式のレコードを観測したか（§形式判定・v1.5.0）
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
  // 任意実装: 全セッションパース前の軽量な事前フィルタ。除外して良いのは
  // 「対象プロジェクトに属し得ない」ファイルだけ（属否が不明なファイルは
  // 残して通常解析へ回すこと）。返却順は発見順を保ち、下流の決定的な出力
  // 順序を崩さないこと。
  prefilterFiles?(
    files: DiscoveredFile[],
    cfg: CcxlogConfig,
    ctx: FilterContext,
  ): Promise<DiscoveredFile[]>;
  readSession(file: DiscoveredFile, cfg: CcxlogConfig): Promise<SessionData>;
  // Keep only the pairs that belong to the target project. Returns the kept
  // pairs plus whether the session belongs to the project at all (used so
  // per-session mode can remove a stale file for an emptied session).
  filterSession(s: SessionData, cfg: CcxlogConfig, ctx: FilterContext): Promise<{ pairs: Pair[]; belongs: boolean }>;
}
