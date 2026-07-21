// Shared type model for ccxlog. UserEntry / AssistantEntry are the UNION
// (superset) of the fields Claude Code and Codex logs carry, so the two
// source readers (sources/claude, sources/codex) and the shared
// pairBuilder-consuming layers all work against one entry shape. Fields
// that only one source populates are optional.

export type Source = 'claude' | 'codex';
export type SourceLabel = 'ClaudeCode' | 'Codex';
export type SourceMode = 'both' | 'claude' | 'codex';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: 'image'; source?: unknown }
  | { type: 'thinking'; thinking?: string }
  | { type: string; [k: string]: unknown };

export type MessageContent = string | ContentBlock[];

export interface UserEntry {
  type: 'user';
  message: { role: 'user'; content: MessageContent };
  uuid: string;
  parentUuid?: string | null;
  timestamp: string;
  isMeta?: boolean;        // Claude only
  isSidechain?: boolean;   // Claude only
  sessionId?: string;
  cwd?: string;
  turnId?: string;         // Codex only
}

export interface AssistantEntry {
  type: 'assistant';
  message: { role: 'assistant'; content: MessageContent };
  uuid: string;
  parentUuid?: string | null;
  timestamp: string;
  isSidechain?: boolean;   // Claude only
  isProgressOnly?: boolean; // Codex only
  sessionId?: string;
  turnId?: string;         // Codex only
}

export type LogEntry =
  | UserEntry
  | AssistantEntry
  | ({ type: string } & Record<string, unknown>);

export interface Pair {
  questionEntry: UserEntry;
  additionalQuestionEntries: UserEntry[];
  progressEntries: Array<UserEntry | AssistantEntry>;
  finalAssistantEntry: AssistantEntry | null;
}

// Out-of-source values stay undefined so a known 0 is distinguishable from
// "the source never reported this field" (§6.1).
export interface TokenTotals {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  reasoning?: number;
}

export interface UnifiedPair {
  source: Source;
  sourceLabel: SourceLabel;
  sessionId: string;
  sessionName: string;
  sourceFile: string;                 // display (absolute path)
  sourceFileRelativeId: string;       // namespaced stable id (§5.5)
  questionEventUuid?: string;
  questionOrdinal: number;            // question order within the session, answer-independent
  questionTimestampRaw: string;
  questionTimestampMs: number | null;
  question: string;
  progressSummary: string;
  progressFull: string;
  answer: string;
  model: string;
  version: string;
  gitBranch: string;
  cwd: string;
  tokens: TokenTotals;
  ccxid: string;                      // assigned later (§9.2), "ccxid:<hex24>"
  // Internal (not rendered): carried from SessionData for logical dedupe (§6.3).
  fileContentHash: string;
  eventIdStreamHash: string[];
  // Internal (not rendered): globally-unique message uuids used to drop
  // resumed/forked copies of the same turn across DIFFERENT sessions (§6.3
  // cross-session dedupe). Populated for Claude only — Codex uuids are per-file
  // positional (u-0, a-1, …) and would collide across sessions — so it is empty
  // for every Codex pair, which excludes them from that pass.
  forkKeys: string[];
}

export interface CliOptions {
  projectPath: string;
  outDir: string;
  mode: SourceMode;
  perSession: boolean;
  dryRun: boolean;
  verbose: boolean;
  initTemplate: boolean;
  backupJsonl: boolean;
  backupMd: boolean;
  lock: boolean;
  forceUnlock: boolean;
}
