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
  // Codex only — material for the inherited-history replay key (lib/replayKey.ts).
  // A Codex subagent rollout re-records the whole parent conversation, so the
  // SAME user message appears in several files with a rewritten outer
  // timestamp. These two fields are what lets the copies be recognised as one
  // message without trusting the timestamp.
  replayMsgId?: string;    // the response_item message-item id (`msg_…`), stable across files
  replayTurnKey?: string;  // `<turn_id>#<index of this user message within the turn>`
  // Codex only: an inter-agent message DELIVERED TO this session (the
  // response_item agent_message that directly follows
  // inter_agent_communication_metadata). Detection result only — whether it
  // opens a Q&A boundary is decided by isDelegateReply below.
  isReceivedInstruction?: boolean;
  // Codex only: this received message came UP from a subagent this session
  // delegated to (a FINAL_ANSWER, or a mid-task MESSAGE from the child), rather
  // than DOWN from a parent assigning work. Such a record is the delegator's own
  // tool result, not a question put to it, so it is filed as progress — matching
  // Claude, where a Task result arrives as a tool_result inside the delegating
  // pair and never opens a block of its own.
  isDelegateReply?: boolean;
  progressKey?: string;    // Codex only — see AssistantEntry.progressKey
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
  // Codex only: what this progress record IS, in a form that identifies it
  // across two files that recorded the same activity — the tool name and the
  // model's own call id, or the reasoning item id.
  //
  // It is a TOP-LEVEL string on purpose. Comparing two copies' progress may not
  // read `message.content`, because progressData.applyProgressRetention()
  // empties the tool blocks there as soon as the template does not reference
  // Progress; a comparison based on them would let the template decide which
  // blocks a run keeps. Top-level primitives survive that pass (they are not in
  // its DEAD_TOP_LEVEL_KEYS denylist), so this one field says the same thing in
  // both directions. It costs a string concatenation per tool record at parse
  // time and nothing afterwards.
  progressKey?: string;
}

export type LogEntry =
  | UserEntry
  | AssistantEntry
  | ({ type: string } & Record<string, unknown>);

// Codex thread identity. One rollout carries THREE distinct ids, and folding
// them into a single `sessionId` is what made a subagent adopt its parent's
// identity, so they are kept apart here.
export interface ThreadIdentity {
  threadId: string;          // payload.id — this thread itself (display / file names)
  lineageSessionId: string;  // payload.session_id — the lineage (parent) id, used for matching
  parentThreadId: string;    // payload.parent_thread_id — the thread that spawned this one
  isSubagent: boolean;       // thread_source === 'subagent', or source.subagent present
  agentName: string;         // agent_nickname, else agent_path
}

export interface Pair {
  questionEntry: UserEntry;
  additionalQuestionEntries: UserEntry[];
  progressEntries: Array<UserEntry | AssistantEntry>;
  finalAssistantEntry: AssistantEntry | null;
  // Does this pair belong to a SUBAGENT conversation? (`includeSubagents`,
  // spec §6). It is set where the fact is known and nowhere else:
  //  - Claude: on every pair built from the `isSidechain` stream of a session
  //    log, and on every pair of a `<session id>/subagents/*.jsonl` transcript
  //    (that file IS a subagent transcript whether or not its entries happen to
  //    carry `isSidechain`).
  //  - Codex: on every pair of a rollout whose authoritative `session_meta`
  //    says `thread_source === "subagent"` or carries `source.subagent`.
  // The display filter reads it, and nothing else does — discovery, parsing,
  // belonging selection and the inherited-history matching all run over hidden
  // pairs exactly as they do over visible ones (spec §7.3, §8).
  isSubagent?: boolean;
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
  // Carried over from `Pair.isSubagent`. The display filter (`includeSubagents`)
  // is applied to UnifiedPairs, after the Codex inherited-history matching and
  // before ccxlogids are assigned (spec §8).
  isSubagent: boolean;
  questionTimestampRaw: string;
  questionTimestampMs: number | null;
  question: string;
  // Lazy + memoised. Building Progress means JSON-stringifying every tool
  // input/output between Q and A — heavy work whose result the default template
  // (which contains neither %Progress% nor %ProgressFull%) merely threw away.
  // formatPair() calls these only when the template actually references them.
  progressSummary: () => string;
  progressFull: () => string;
  answer: string;
  model: string;
  version: string;
  gitBranch: string;
  cwd: string;
  tokens: TokenTotals;
  ccxid: string;                      // internal field, rendered as "ccxlogid:<hex24>"
  // Internal fields (never rendered): the logical-dedupe data inherited from
  // SessionData (§6.3). fileContentHash is a lazy, memoised async accessor that
  // re-reads and hashes the file only when a §6.3 confirmation actually needs it
  // (almost never) — unlike the old implementation, which hashed every log byte
  // every time. eventIdStream holds the raw "type\0id" strings; strictPrefix
  // compares elements for equality, so its discriminating power is identical to
  // the old per-element SHA-256 without paying for a cryptographic hash per line.
  fileContentHash: () => Promise<string>;
  eventIdStream: string[];
  // Internal (not rendered): globally-unique message uuids used to drop
  // resumed/forked copies of the same turn across DIFFERENT sessions (§6.3
  // cross-session dedupe). Populated for Claude only — Codex uuids are per-file
  // positional (u-0, a-1, …) and would collide across sessions — so it is empty
  // for every Codex pair, which excludes them from that pass.
  forkKeys: string[];
  // Internal (never rendered): the identity of this pair's user message(s),
  // independent of the file they were read from. Used ONLY to recognise the
  // parent-history replay inside a Codex subagent rollout
  // (sources/codex/inheritedHistory.ts). `replayKey` is '' for Claude and for
  // any Codex pair whose messages lack the material to build one — an empty key
  // means "cannot be proven a replay", so the pair is kept. `replayTextHash`
  // covers the text of every user message of the pair, in order, and is the
  // final confirmation before anything is dropped.
  replayKey: string;
  replayTextHash: string;
  // Internal: a hash of every text this copy of the turn could show as its
  // answer (lib/replayKey.ts). A copy taken while the turn was still running
  // ends on one of the other copy's intermediate messages, and that has to be
  // told apart from two copies genuinely disagreeing.
  answerTextHashes: string[];
  // Internal: how many progress records back this pair, and what each of them
  // is (lib/replayKey.progressSignatureOf). Deciding which copy of a turn holds
  // the richer progress must NOT mean rendering Progress on both sides: that is
  // the heavy work v1.6.0 made lazy, and — worse — the rendered text is empty
  // whenever the template does not reference Progress, which would let the
  // template decide which blocks survive. The signature is lazy and memoised
  // like the accessors above, and is built only from what survives
  // progressData.applyProgressRetention().
  progressEntryCount: number;
  progressSignature: () => string[];
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
  // watch (watch-spec §3). `watch` records whether --watch was given;
  // `watchDurationSeconds` is the run duration D (null means unlimited).
  watch: boolean;
  watchDurationSeconds: number | null;
}
