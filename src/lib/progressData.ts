// Drop Progress data the template never uses.
//
// `Pair.progressEntries` holds every tool input/output between Q and A as RAW
// entries. `--watch` stays resident with those entries in the incremental
// re-parse cache, so with the default template (which references neither
// `%Progress%` nor `%ProgressFull%`) the process would hold data nobody ever
// reads, forever. v1.3.0 already made building the Progress STRING lazy, but the
// raw entries it is built from stayed. This is where they go.
//
// ## Why entries are slimmed rather than removed (design decision)
//
// `progressEntries` is read for more than Progress. Emptying the array itself
// breaks four paths — that is, it changes the output.
//
// | Path | Read by | Needs |
// |---|---|---|
// | `%Model%` | `metaExtractor.extractModel` | the assistant's `message.model` |
// | `%Tokens%` | `metaExtractor.extractTokenTotals` | the assistant's `message.usage` |
// | `%Version%` / `%GitBranch%` / `%Cwd%` + Codex's belongs-check | `metaExtractor.anchorField` / `extractCwd` | top-level string fields of the entry |
// | `%Answer%` fallback | `markdownWriter.buildAnswer` | the assistant's text blocks (and `isProgressOnly`) |
//
// So we keep every element and minimise only its contents: the light values
// those four paths read stay, and the heavy payloads (tool result bodies, tool
// inputs, reasoning text, the file contents in `toolUseResult`) go. Array
// length, order and types are unchanged, so all four paths keep returning the
// same answers.
//
// ## Why top-level fields use a denylist
//
// Of the paths above only `anchorField` is a generic key lookup, and the keys
// actually passed to it are fixed at three: `version`, `gitBranch`, `cwd`.
// Still, "keep every top-level field" leaves the id/time fields (`uuid`,
// `parentUuid`, `sessionId`, `timestamp`, …) sitting in memory unread. On real
// data (ccxlog's own logs) the id/time fields alone accounted for 2.43MB on the
// Claude side and 3.74MB on the Codex side, out of 4.08MB / 7.92MB of top-level
// fields.
//
// The filter is a DENYLIST, not a whitelist. A whitelist fails toward "silently
// drop a field a future log format adds", so the output would change the moment
// `anchorField` is called with a new key. With a denylist, unknown fields always
// fail toward being kept. Only id/time fields confirmed — by auditing every read
// in this repository — to be read by nobody after analysis are dropped; they are
// listed with their justification in `DEAD_TOP_LEVEL_KEYS`.
//
// ## Why this cannot break `recoverSlashCommandBodies()`
//
// Recovering slash-command bodies reads `pair.progressEntries[].toolUseResult`,
// but that work FINISHES at the end of `buildPairs()` (claude/pairBuilder.ts).
// This module runs after `buildPairs()` has returned, so recovery always ran
// against the complete, un-slimmed entries. Its results are written back into
// `additionalQuestionEntries[].message.content` — which this module never
// touches — so `%Question%` still renders the full body after slimming. For the
// same reason Codex's "decide pair boundaries from the presence of in-progress
// entries" logic (codex/pairBuilder.ts) is settled at build time and is
// unaffected by a transform that does not change the element count.
//
// ## When the decision is made
//
// Whether the data is needed follows from the template (config), which can
// change while `--watch` is running. The incremental re-parse cache drops every
// entry when the analysis fingerprint changes, so including this flag in the
// fingerprint (see `analysisFingerprint` in index.ts) rules out reusing a
// slimmed session — read during a no-reference cycle — in a cycle that does
// reference Progress.
import type { CcxlogConfig } from './config.js';
import { templateUsesProgress } from './templates.js';
import type { AssistantEntry, ContentBlock, MessageContent, Pair, UserEntry } from './types.js';

type ProgressEntry = UserEntry | AssistantEntry;
type Raw = Record<string, unknown>;

/** Does this template need Progress data retained at all? */
export function progressDataNeeded(cfg: Pick<CcxlogConfig, 'template'>): boolean {
  return templateUsesProgress(cfg.template);
}

// Keep only the text blocks of an assistant's content. The `%Answer%` fallback
// (`extractLastAssistantText`) reads text blocks exclusively, and takes the LAST
// one; dropping non-text blocks while preserving order leaves that same block in
// place. String content is entirely text, so it is kept as is.
function textOnlyContent(content: unknown): MessageContent {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return [];
  return (content as ContentBlock[]).filter(b => b && b.type === 'text');
}

// Top-level fields confirmed to be read by NOBODY once an in-progress entry has
// been analysed. Each is spent by the time `applyProgressRetention()` runs
// inside `readSession()`:
//
// | Key | Read where | Why it is dead after analysis |
// |---|---|---|
// | `uuid` / `parentUuid` | claude/pairBuilder (pair boundaries, sibling forks); markdownWriter's `forkKeys` / `questionEventUuid` | pairBuilder finishes inside `buildPairs()`; `forkKeys` looks only at questionEntry / additionalQuestionEntries / finalAssistantEntry and reads NO progressEntries |
// | `timestamp` | claude/pairBuilder (normalisation); markdownWriter's `%DateTime%` | `%DateTime%` reads `pair.questionEntry.timestamp` only |
// | `sessionId` / `session_id` | codex/jsonlReader (taken from the session_meta payload) | the payload is what is read; the value on the entry never is (`%SessionId%` comes from `SessionData.sessionId`) |
// | `turnId` | codex/jsonlReader (turn-boundary matching) | completed in a stage before `buildPairs()` |
// | `requestId` / `promptId` / `userType` / `sourceToolAssistantUUID` | read from NOWHERE (Claude logs merely carry them) | — |
//
// `toolUseResult` (the file contents used to recover slash-command bodies) is
// already removed by the "drop top-level objects" rule below, but real data
// sometimes carries it as a STRING, so it is listed explicitly (recovery itself
// completes inside `buildPairs()`, so it is dead after analysis either way).
const DEAD_TOP_LEVEL_KEYS = new Set([
  'uuid', 'parentUuid', 'timestamp',
  'sessionId', 'session_id', 'turnId',
  'requestId', 'promptId', 'userType', 'sourceToolAssistantUUID',
  'toolUseResult',
]);

// Rebuild one entry as a minimised NEW object rather than mutating the original.
// The original comes from freshly parsed JSON, so dropping the reference makes
// it garbage and reclaims the huge strings with it.
function slimEntry(entry: ProgressEntry): ProgressEntry {
  const src = entry as unknown as Raw;
  const slim: Raw = {};
  for (const key of Object.keys(src)) {
    if (key === 'message') continue;
    // Drop only the id/time fields confirmed to be read by nobody (denylist).
    // Unknown fields fail toward being kept, so a growing log format never moves
    // the output.
    if (DEAD_TOP_LEVEL_KEYS.has(key)) continue;
    const value = src[key];
    // The remaining top-level primitives (type / cwd / version / gitBranch /
    // isProgressOnly / isSidechain / …) are small and `anchorField` may read
    // them, so they stay. Objects (Claude's `toolUseResult`, i.e. the contents
    // of a file that was read) are used only by Progress and slash-command
    // recovery, so they go.
    if (value === null || typeof value !== 'object') slim[key] = value;
  }
  const msg = (src.message ?? {}) as Raw;
  const slimMsg: Raw = { role: msg.role };
  if (msg.model !== undefined) slimMsg.model = msg.model;   // %Model%
  if (msg.usage !== undefined) slimMsg.usage = msg.usage;   // %Tokens% (a few numbers)
  // By construction an in-progress user entry holds tool_result blocks only
  // (pairBuilder admits a user entry only when `contentHasOnlyToolResults`
  // holds). That body renders in Progress alone, so it is dropped wholesale.
  slimMsg.content = entry.type === 'assistant' ? textOnlyContent(msg.content) : [];
  slim.message = slimMsg;
  return slim as unknown as ProgressEntry;
}

/**
 * Discard the heavy payloads Progress would have rendered.
 *
 * No marker recording "this pair was slimmed" is left behind. The analysis
 * fingerprint (`analysisFingerprint` in `index.ts`) already guarantees that a
 * slimmed pair and a Progress-referencing template never coexist, which made a
 * marker-checking safety net unreachable, so it was removed in Round 2.
 */
export function dropProgressData(pairs: Pair[]): void {
  for (const pair of pairs) {
    pair.progressEntries = pair.progressEntries.map(slimEntry);
  }
}

/**
 * Apply `dropProgressData()` only when the template does not reference Progress.
 * Each source calls this from `readSession()`, so it saves the same memory
 * under `--watch` (before entries reach the cache) as it does for a single run
 * (peak memory).
 */
export function applyProgressRetention(pairs: Pair[], cfg: Pick<CcxlogConfig, 'template'>): Pair[] {
  if (!progressDataNeeded(cfg)) dropProgressData(pairs);
  return pairs;
}
