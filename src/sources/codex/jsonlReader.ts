import fs from 'node:fs/promises';
import { forEachLine } from '../../lib/lineStream.js';
import { lazyFileSha256, sha256HexBytes } from '../../lib/pathUtils.js';
import type { AssistantEntry, ContentBlock, LogEntry, ThreadIdentity, UserEntry } from '../../lib/types.js';

export interface CodexReadResult {
  entries: LogEntry[];
  skippedLines: number;
  fileSize: number;
  formatRecognized: boolean;   // was a Codex rollout record seen? (§format detection, v1.5.0)
  fileContentHash: () => Promise<string>;   // lazy + memoised (§6.3 complete-copy check)
  eventIdStream: string[];
  sessionId: string;
  sessionCwd: string;
  sessionName: string;
  thread: ThreadIdentity;
}

// Extract the cwd from one Codex rollout record. The format knowledge that only
// session_meta and turn_context can carry one, in payload.cwd, lives in this
// function alone. Both the normal reader (readJsonl) and the prefilter
// (cwdScanner) go through it, so a future change to Codex's log format cannot
// update just one of them and start excluding legitimate logs.
// recognized=false means "a record type this function does not know"; the
// prefilter must not treat it as grounds for exclusion and falls back to normal
// analysis (see the unknownFormat guard in cwdScanner.ts).
export function extractCodexCwdRecord(event: unknown): { recognized: boolean; cwd?: string } {
  const e = raw(event);
  if (e.type !== 'session_meta' && e.type !== 'turn_context') {
    return { recognized: false };
  }
  const cwd = text(raw(e.payload).cwd);
  return { recognized: true, ...(cwd !== '' ? { cwd } : {}) };
}

type Raw = Record<string, unknown>;
const raw = (value: unknown): Raw => value && typeof value === 'object' ? value as Raw : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => {
    const block = raw(item);
    return ['input_text', 'output_text', 'text'].includes(text(block.type)) ? text(block.text) : '';
  }).filter(Boolean).join('\n');
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => {
    if (typeof item === 'string') return item;
    const block = raw(item);
    return text(block.text) || JSON.stringify(item);
  }).join('\n');
  try { return JSON.stringify(value); } catch { return String(value); }
}

function reasoningText(payload: Raw): string {
  const summary = payload.summary;
  if (!Array.isArray(summary)) return text(summary);
  return summary.map(item => text(raw(item).text)).filter(Boolean).join('\n');
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

// A short fingerprint of what a progress record actually SAYS, appended to its
// id-based `progressKey`. The id alone cannot separate two records that share a
// call_id but carry different output — the one remaining way the identity check
// could fail toward deleting a child record that genuinely diverges. Taking the
// fingerprint HERE, at parse time and into one short string, keeps everything
// the id-based design bought: the comparison still never reads
// `message.content`, so it stays independent of the template and never forces
// Progress to be built.
function bodyPrint(value: string): string {
  return value ? `~${sha256HexBytes(value, 12)}` : '';
}

// Injected context that reaches the log as a response_item user message but
// was never typed by the human — must not be recovered as a question.
// These are opening tag names rather than complete tags because real records
// may carry attributes, for example `<codex_internal_context source="goal">`.
const FALLBACK_NOISE_TAGS = [
  'environment_context', 'permissions', 'user_instructions',
  'codex_internal_context', 'recommended_plugins',
];

function startsWithOpeningTag(value: string, tag: string): boolean {
  const opening = `<${tag}`;
  if (!value.startsWith(opening)) return false;
  const boundary = value[opening.length];
  return boundary === '>' || boundary === '/'
    || (boundary !== undefined && /\s/.test(boundary));
}

function isFallbackNoise(value: string): boolean {
  const head = value.trimStart();
  return head.startsWith('<system-')
    || FALLBACK_NOISE_TAGS.some(tag => startsWithOpeningTag(head, tag));
}

// A stable, per-response_item-UNIQUE id for a user message — or '' when none can
// be verified. This is the ONLY key allowed to prove that a repeated fallback is
// a replay of the same record (rather than a legitimately repeated question).
//
// Verified per known Codex rollout schema (observed across real logs): every
// response_item ITEM object may carry its own `id`, following the Responses-API
// item-id convention — `msg_…` for messages, `rs_…`/`fc_…`/`ctc_…` for
// reasoning/tool items — and that id is unique per item, so a repeat of it marks
// a true replay. USER (and developer) message items are INPUT items and are
// assigned NO id at all (payload.id / event.id both absent in every observed
// user message). We therefore accept ONLY a `msg_`-prefixed `payload.id` — the
// message item's own id — as a resend key:
//   - `event.id` (the rollout LINE wrapper) is rejected: its per-item uniqueness
//     is unverified and it is absent in observed logs (r5 report, cx5 weaknesses).
//   - a `payload.id` that does NOT match the known message-item id form is
//     rejected, so a future/foreign non-unique parent or turn id placed there can
//     never be mistaken for a per-item id and drop a genuine question.
// When no verified id is present — the real-world case for user messages — this
// returns '' and the caller keeps the message, honoring the spec's
// "keep it unless you can prove otherwise" rule (§6.2).
function verifiedUserMessageId(payload: Raw): string {
  const id = text(payload.id);
  return id.startsWith('msg_') ? id : '';
}

// The record that marks the next line as inter-agent traffic. In the real logs
// it is the record's OUTER type and its payload holds nothing but
// `{ trigger_turn: true }`:
//   {"timestamp":…,"type":"inter_agent_communication_metadata","payload":{"trigger_turn":true}}
// The payload type is accepted as well, so a future move of the discriminator
// into the payload keeps working. Checking only one of the two is exactly the
// mistake that made this feature never fire on real data.
const INTER_AGENT_MARKER = 'inter_agent_communication_metadata';

function isInterAgentMarker(event: Raw, payload: Raw): boolean {
  return text(event.type) === INTER_AGENT_MARKER || text(payload.type) === INTER_AGENT_MARKER;
}

// An instruction handed TO a subagent, as recorded right after the marker:
//   {"type":"response_item","payload":{"type":"agent_message","id":"amsg_…",
//    "author":"/root","recipient":"/root/r1_review",
//    "content":[{"type":"input_text","text":"Message Type: NEW_TASK…"},
//               {"type":"encrypted_content","encrypted_content":"gAAAA…"}],
//    "internal_chat_message_metadata_passthrough":{"turn_id":"…"}}}
//
// Three properties of that shape are easy to get wrong and each one on its own
// makes the detection miss every real instruction:
//  - the item type is `agent_message`, not `message`;
//  - there is NO `role` field, so `role === 'assistant'` never matches;
//  - 6 of the 29 observed instructions carry no `id` at all, so the id can
//    never be a precondition.
// `message` is accepted too (with any role other than 'user') purely as
// forward/backward compatibility; it is not the observed shape.
function isReceivedInstructionItem(itemType: string, payload: Raw): boolean {
  if (itemType === 'agent_message') return true;
  return itemType === 'message' && text(payload.role) !== 'user';
}

// The instruction's own item id. Instructions use the `amsg_` prefix, NOT the
// `msg_` of user messages, and only 23 of 29 have one — hence a separate
// function that leaves verifiedUserMessageId (and the resend logic that depends
// on its exact meaning) untouched.
function instructionItemId(payload: Raw): string {
  const id = text(payload.id);
  return id.startsWith('amsg_') || id.startsWith('msg_') ? id : '';
}

// An instruction's turn id lives in the passthrough block — neither at the top
// level nor at payload.turn_id — and it matters because the instruction is
// recorded BEFORE the turn it starts opens, so the reader's running turn id
// still names the PREVIOUS turn at that point.
function instructionTurnId(payload: Raw): string {
  return text(raw(payload.internal_chat_message_metadata_passthrough).turn_id);
}

// Read the thread identity out of a session_meta payload.
//
// A subagent is recognised by `thread_source === "subagent"` OR the presence of
// `source.subagent`. `forked_from_id` is deliberately NOT part of the test: it
// is missing from 1 of the 12 observed subagent rollouts, so using it alone
// would misclassify that one as a normal session.
//
// The three ids are kept apart on purpose. In a subagent rollout `payload.id`
// is the child's own thread (and matches the uuid in the file name) while
// `payload.session_id` is the PARENT's id; folding them into one field is what
// made every child adopt its parent's identity.
function threadIdentityOf(payload: Raw): ThreadIdentity {
  const source = raw(payload.source);
  const sub = raw(source.subagent);
  // The nickname and the agent path appear directly on the payload and,
  // nested, under source.subagent.thread_spawn — both are read, so neither
  // placement is required.
  const spawn = raw(sub.thread_spawn);
  const pick = (key: string): string => text(payload[key]) || text(sub[key]) || text(spawn[key]);
  return {
    threadId: text(payload.id),
    lineageSessionId: text(payload.session_id),
    parentThreadId: pick('parent_thread_id'),
    isSubagent: text(payload.thread_source) === 'subagent'
      || (Object.hasOwn(source, 'subagent') && source.subagent != null),
    agentName: pick('agent_nickname') || pick('agent_path'),
  };
}

const USAGE_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
] as const;

// Credit usage as the DELTA of the cumulative counter so a re-emitted
// token_count doesn't double-count. Counter resets (compaction/restart) fall
// back to last_token_usage.
//
// `inheritedBaseline` says that the first report in this file continues someone
// else's count instead of starting one — see the comment on the branch below.
function usageDelta(info: Raw, prevTotal: Raw | null, inheritedBaseline = false): Raw | null {
  const total = info.total_token_usage;
  const last: Raw | null = info.last_token_usage ? raw(info.last_token_usage) : null;
  if (!total || typeof total !== 'object') return last;
  const totalRaw = total as Raw;
  // FIRST report: the delta from a zero baseline IS the whole cumulative total,
  // which may already cover several API calls made before this notification.
  // Crediting last_token_usage here (only the most recent call) undercounts, so
  // adopt the cumulative total (§6.2: "count from the delta of the cumulative
  // total_token_usage").
  //
  // That reasoning holds only when the file starts the count. A subagent
  // rollout opens with the parent's conversation re-recorded from wherever it
  // had got to, so its first token_count carries the PARENT's running total —
  // measured in the real logs as 31,643,877 input tokens landing on a single
  // question, against the 142,977 that turn actually used. It is bookkeeping
  // this file inherited, not usage, so it becomes the baseline instead of a
  // credit and only the most recent call is counted.
  if (!prevTotal) return inheritedBaseline ? last : totalRaw;
  const reset = USAGE_FIELDS.some(k =>
    typeof totalRaw[k] === 'number'
    && typeof prevTotal[k] === 'number'
    && (totalRaw[k] as number) < (prevTotal[k] as number),
  );
  if (reset) return last ?? totalRaw;
  const delta: Raw = {};
  let any = false;
  for (const k of USAGE_FIELDS) {
    const d = Math.max(0, num((total as Raw)[k]) - num(prevTotal[k]));
    delta[k] = d;
    if (d > 0) any = true;
  }
  return any ? delta : null;
}

// Parse Codex rollout JSONL directly into the stable Q&A entry model. Uses
// event_msg for human/assistant text (response_item messages are duplicates);
// response_item is authoritative for reasoning and tool activity.
export async function readJsonl(filePath: string, includeDeveloperMessages = false): Promise<CodexReadResult> {
  const stat = await fs.stat(filePath);
  const entries: LogEntry[] = [];
  let skippedLines = 0;
  let sequence = 0;
  let sessionId = '';
  let sessionName = '';
  let sessionCwd = '';
  let cwd = '';
  let version = '';
  let model = '';
  let gitBranch = '';
  let turnId = '';
  let sawUserEvent = false;
  let thread: ThreadIdentity = {
    threadId: '', lineageSessionId: '', parentThreadId: '', isSubagent: false, agentName: '',
  };
  // In a SUBAGENT rollout the first session_meta is the authoritative one
  // (§ requirement 2): the child replays the parent's conversation,
  // session_meta included, so every later one describes the PARENT, not this
  // file. Other rollouts keep the baseline's last-wins metadata.
  let sessionMetaSeen = false;
  // Was the PREVIOUS record the inter-agent marker? The instruction handed to a
  // subagent is the response_item that directly follows it.
  let afterInterAgentMarker = false;
  // Replay-key material (lib/replayKey.ts), collected per turn.
  // - how many user messages this turn has already produced, so each gets its
  //   own index and a turn carrying several of them cannot collapse to one key.
  const turnUserCounts = new Map<string, number>();
  // - every user entry emitted, with its turn, so the `msg_…` ids that only the
  //   response_item copies carry can be handed over at EOF.
  const pendingUsers: Array<{ entry: UserEntry; turnId: string; content: string }> = [];
  // - the `msg_…` ids seen on this turn's response_item user messages. The same
  //   message reaches the log twice (event_msg for display, response_item for
  //   the model) and only the response_item copy carries the id.
  const itemIdsByTurn = new Map<string, Array<{ content: string; id: string; used: boolean }>>();
  // Users recovered from response_item (only when the turn has no
  // event_msg.user_message). Keep ALL of them, each with its own timestamp, so
  // a turn with several fallback questions doesn't collapse to just the last
  // one and a trailing fallback at EOF isn't lost.
  let fallbackUsers: Array<{ content: string; timestamp: string }> = [];
  // Verified per-item message ids already seen this turn — the only signal that
  // lets us drop a fallback as a replay. Reset at every turn boundary.
  const fallbackStableIds = new Set<string>();
  let prevTotalUsage: Raw | null = null;

  const common = (timestamp: string) => ({
    timestamp, sessionId, cwd: cwd || sessionCwd, version, model, gitBranch, turnId,
  });
  // `instruction` marks an incoming subagent instruction and carries the turn
  // id read from the record itself, because such a record precedes the
  // turn_context that opens its turn.
  const pushUser = (
    content: string,
    timestamp: string,
    instruction?: { turnId: string; msgId: string },
  ): void => {
    const ownTurnId = instruction?.turnId || turnId;
    const entry: UserEntry = {
      type: 'user', uuid: `u-${sequence++}`,
      message: { role: 'user', content }, ...common(timestamp), turnId: ownTurnId,
    };
    if (instruction) {
      entry.isReceivedInstruction = true;
      if (instruction.msgId) entry.replayMsgId = instruction.msgId;
    }
    // The turn key is fixed at PUSH time: the running turn id moves on at the
    // next turn_context, and the key has to describe the turn this message was
    // part of. The index counts RENDERED user messages only — the duplicate
    // response_item copy of a message must not consume a number, or the same
    // message would be numbered differently in two files that recorded the two
    // copies in a different order. Without a turn id there is no key, and the
    // pair is then never removable as a replay: the safe direction.
    if (ownTurnId) {
      const n = turnUserCounts.get(ownTurnId) ?? 0;
      turnUserCounts.set(ownTurnId, n + 1);
      entry.replayTurnKey = `${ownTurnId}#${n}`;
    }
    pendingUsers.push({ entry, turnId: ownTurnId, content });
    entries.push(entry);
  };
  const pushAssistant = (
    content: ContentBlock[],
    timestamp: string,
    progressOnly = false,
  ): AssistantEntry => {
    const entry = {
      type: 'assistant' as const, uuid: `a-${sequence++}`,
      message: { role: 'assistant' as const, content, model },
      ...(progressOnly ? { isProgressOnly: true } : {}),
      ...common(timestamp),
    } as AssistantEntry;
    entries.push(entry);
    return entry;
  };
  const attachUsage = (usage: Raw, timestamp: string): void => {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type !== 'assistant') continue;
      if (raw(entries[i]).turnId !== turnId) continue;
      const msg = raw((entries[i] as AssistantEntry).message);
      if (msg.usage === undefined) {
        msg.usage = usage;
        return;
      }
      break;
    }
    raw(pushAssistant([], timestamp, true).message).usage = usage;
  };
  // Materialize the user message(s) recovered from response_item (only when no
  // event_msg.user_message was seen for this turn). Flushed at every turn
  // boundary, before the model's response, and at EOF — NOT only at
  // task_complete — so an interrupted turn (no task_complete) still keeps its
  // question and multiple fallbacks are all preserved (§6.2). Each keeps its
  // own timestamp so ordering stays correct.
  const flushFallback = (): void => {
    if (!sawUserEvent && fallbackUsers.length) {
      for (const fb of fallbackUsers) pushUser(fb.content, fb.timestamp);
      sawUserEvent = true;   // guard against a double-flush within the turn
    }
    fallbackUsers = [];
  };

  // What makes a file recognisable as a Codex rollout: at least one rollout
  // record type (session_meta / turn_context / event_msg / response_item). A file
  // with none (a Claude session log, or an unrelated jsonl) is left out as a
  // source mismatch (§format detection, v1.5.0).
  let formatRecognized = false;
  await forEachLine(filePath, (line) => {
    if (!line.trim()) return;
    let event: Raw;
    try { event = JSON.parse(line) as Raw; } catch { skippedLines++; return; }
    if (event.type === 'session_meta' || event.type === 'turn_context'
      || event.type === 'event_msg' || event.type === 'response_item') formatRecognized = true;
    const payload = raw(event.payload);
    const timestamp = text(event.timestamp);
    // Snapshot "the previous record was the inter-agent marker" before any of
    // the early returns below can skip the update. The marker itself is not a
    // response_item, so a `return` placed in front of the response_item branch
    // would otherwise clear the flag on the very line that should set it.
    const precededByMarker = afterInterAgentMarker;
    afterInterAgentMarker = isInterAgentMarker(event, payload);

    if (event.type === 'session_meta') {
      // The thread identity is read from the FIRST session_meta only, in every
      // rollout. It is what `isSubagent` is decided from, so it cannot itself
      // depend on a later record — and in a subagent rollout every later meta
      // is the replayed PARENT's.
      const first = !sessionMetaSeen;
      if (first) {
        sessionMetaSeen = true;
        thread = threadIdentityOf(payload);
      }
      // § requirement 2 makes the first meta authoritative for the CHILD file:
      // in a subagent rollout a later meta describes the parent, and letting it
      // through replaces the child's identity, working directory, CLI version
      // and branch with the parent's. That is a statement about subagents, and
      // it is applied to subagents alone. A normal session keeps the baseline's
      // last-wins behaviour unchanged — a resumed session records a fresh meta
      // when its cwd or CLI version changes, and that later value is the
      // correct one to show.
      if (!first && thread.isSubagent) return;
      // For a subagent the child's OWN id is `payload.id`, while
      // `payload.session_id` names the lineage (the parent). Every other
      // rollout has the two equal (21/21 observed), so keeping session_id first
      // there preserves the established id exactly — no non-subagent session
      // changes identity because of this.
      sessionId = (thread.isSubagent
        ? thread.threadId || thread.lineageSessionId
        : text(payload.session_id) || text(payload.id)) || sessionId;
      // A subagent has no session_name of its own; its nickname (else its agent
      // path) is what identifies it to a reader (§ requirement 1). Again only
      // for subagents, so a normal session's name priority is untouched.
      sessionName = (thread.isSubagent ? thread.agentName : '')
        || text(payload.session_name) || text(payload.title) || sessionName;
      // cwd extraction goes through the shared function (extractCodexCwdRecord),
      // so the prefilter works from identical format knowledge.
      sessionCwd = extractCodexCwdRecord(event).cwd || sessionCwd;
      cwd = sessionCwd;
      version = text(payload.cli_version) || version;
      gitBranch = text(raw(payload.git).branch) || gitBranch;
      return;
    }
    if (event.type === 'turn_context') {
      turnId = text(payload.turn_id) || turnId;
      cwd = extractCodexCwdRecord(event).cwd || cwd;
      model = text(payload.model) || model;
      return;
    }
    if (event.type === 'event_msg' && payload.type === 'task_started') {
      // Flush any question the previous turn recovered but never got to emit
      // (e.g. it had no task_complete) before resetting for the new turn.
      flushFallback();
      turnId = text(payload.turn_id) || turnId;
      sawUserEvent = false;
      fallbackUsers = [];
      fallbackStableIds.clear();
      return;
    }
    if (event.type === 'event_msg' && payload.type === 'user_message') {
      const value = text(payload.message);
      if (value) pushUser(value, timestamp);
      sawUserEvent = true;
      return;
    }
    if (event.type === 'event_msg' && payload.type === 'agent_message') {
      flushFallback();   // the model's answer closes the user turn
      const value = text(payload.message);
      if (value) pushAssistant([{ type: 'text', text: value }], timestamp);
      return;
    }
    if (event.type === 'event_msg' && payload.type === 'token_count') {
      const info = raw(payload.info);
      const usage = usageDelta(info, prevTotalUsage, thread.isSubagent);
      if (info.total_token_usage && typeof info.total_token_usage === 'object') {
        prevTotalUsage = raw(info.total_token_usage);
      }
      if (usage && Object.keys(usage).length) attachUsage(usage, timestamp);
      return;
    }
    if (event.type === 'event_msg' && payload.type === 'task_complete') {
      flushFallback();
      const answer = text(payload.last_agent_message);
      let latestText = '';
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].type !== 'assistant') continue;
        if (raw(entries[i]).turnId !== turnId) continue;
        latestText = messageText((entries[i] as AssistantEntry).message.content);
        if (latestText) break;
      }
      if (answer && answer !== latestText) pushAssistant([{ type: 'text', text: answer }], timestamp);
      return;
    }
    if (event.type !== 'response_item') return;

    const itemType = text(payload.type);
    if (precededByMarker && isReceivedInstructionItem(itemType, payload)) {
      // An instruction DELIVERED TO this subagent (§ requirement 3). Note that
      // `agent_message` means the exact opposite here than it does under
      // event_msg, where it is the agent's OWN reply (2,575 of those against 29
      // of these): same name, opposite direction. Only the response_item form,
      // and only directly after the marker, is an incoming instruction.
      //
      // Restoring this boundary has to happen BEFORE any inherited pair is
      // removed. Without it the subagent's own answer stays attached to the
      // last question it inherited from its parent, and removing that inherited
      // question takes the child's answer down with it.
      //
      // The `Message Type` in the body (NEW_TASK / MESSAGE / FINAL_ANSWER /
      // whatever is added later) is deliberately NOT used to filter: narrowing
      // to NEW_TASK would silently drop the 3 observed MESSAGE follow-ups.
      flushFallback();
      // Only `input_text` blocks: the observed content mixes in an
      // `encrypted_content` block whose payload is a very large Base64 blob,
      // and messageText() takes the text blocks alone.
      const value = text(payload.message) || messageText(payload.content);
      if (value) {
        pushUser(value, timestamp, {
          turnId: instructionTurnId(payload),
          msgId: instructionItemId(payload),
        });
      }
      // sawUserEvent is deliberately NOT set: the instruction is not a
      // response_item user message, so it cannot be re-recovered as a fallback,
      // and setting it would suppress a genuine fallback question later in the
      // same turn.
    } else if (itemType === 'message') {
      if (payload.role === 'user') {
        const value = messageText(payload.content);
        // Drop a fallback ONLY as a verified REPLAY: the same record re-serialized
        // into the rollout, proven by a repeat of its stable per-item message id
        // (verifiedUserMessageId — a `msg_…` payload.id). Without such a verified
        // id — the real-world case, where user response_items carry no id — keep
        // every message, even identical content at an identical timestamp, since
        // it may be a genuine repeated question (same text typed twice in the same
        // millisecond) and a resend and a real repeat are indistinguishable
        // without an id. This is the conservative "keep it unless you can prove
        // otherwise" of §6.2, and never prunes on the ambiguous
        // (timestamp, content) key (r5 report: approach A's flaw was dropping a
        // legitimately distinct utterance; approach B excludes only when an id
        // is present).
        if (value && !isFallbackNoise(value)) {
          const stableId = verifiedUserMessageId(payload);
          if (!stableId || !fallbackStableIds.has(stableId)) {
            fallbackUsers.push({ content: value, timestamp });
            if (stableId) {
              fallbackStableIds.add(stableId);
              // Remember the id so the event_msg copy of this very message —
              // which carries no id of its own — can inherit it at EOF.
              const ids = itemIdsByTurn.get(turnId) ?? [];
              ids.push({ content: value, id: stableId, used: false });
              itemIdsByTurn.set(turnId, ids);
            }
          }
        }
      } else if (payload.role === 'developer' && includeDeveloperMessages) {
        flushFallback();
        const value = messageText(payload.content);
        if (value) pushAssistant([{ type: 'text', text: `[Developer] ${value}` }], timestamp, true);
      }
    } else if (itemType === 'reasoning') {
      // Reasoning is progress, never the final answer — mark progressOnly so an
      // interrupted turn (no agent_message / task_complete) does not surface it
      // as %Answer% (§6.2).
      flushFallback();
      const value = reasoningText(payload);
      if (value) {
        const entry = pushAssistant([{ type: 'thinking', thinking: value }], timestamp, true);
        entry.progressKey = `reasoning#${text(payload.id)}${bodyPrint(value)}`;
      }
    } else if (itemType === 'custom_tool_call' || itemType === 'function_call') {
      // Tool calls are progress too — same reasoning as above.
      flushFallback();
      const id = text(payload.call_id) || text(payload.id);
      const name = text(payload.name) || 'unknown';
      const input = parseToolInput(payload.input ?? payload.arguments);
      const entry = pushAssistant([{ type: 'tool_use', id, name, input }], timestamp, true);
      // The call id is the model's own, so the parent's record of a call and the
      // child's re-recording of that same call carry the same one.
      entry.progressKey = `call:${name}#${id}${bodyPrint(JSON.stringify(input ?? null))}`;
    } else if (itemType === 'custom_tool_call_output' || itemType === 'function_call_output') {
      const callId = text(payload.call_id);
      const resultText = outputText(payload.output);
      const result: ContentBlock = {
        type: 'tool_result', tool_use_id: callId, content: resultText,
      };
      const entry: UserEntry = {
        type: 'user', uuid: `r-${sequence++}`,
        progressKey: `result#${callId}${bodyPrint(resultText)}`,
        message: { role: 'user', content: [result] }, ...common(timestamp),
      };
      entries.push(entry);
    }
  });

  // EOF: a turn whose only user input was a response_item fallback (no
  // task_started/agent_message/task_complete after it) still needs its
  // question emitted, so flush any pending fallbacks now (§6.2).
  flushFallback();

  // Hand each `msg_…` message-item id over to the user entry it describes. The
  // id only ever appears on the response_item copy of a message, while the
  // entry we emit normally comes from the event_msg copy, so the two are joined
  // here by (turn, text) in order. Done at EOF rather than per record because a
  // fallback can be flushed either before or after its response_item is read —
  // which of the two copies a file records first must not change the outcome.
  // No match simply leaves the entry with its turn key alone.
  for (const p of pendingUsers) {
    if (p.entry.replayMsgId) continue;      // an instruction brought its own id
    const ids = itemIdsByTurn.get(p.turnId);
    if (!ids) continue;
    const hit = ids.find(x => !x.used && x.content === p.content);
    if (hit) {
      hit.used = true;
      p.entry.replayMsgId = hit.id;
    }
  }

  // Raw "type id" strings: strictPrefix() compares elements for equality, so raw
  // strings discriminate exactly as well as the old per-element SHA-256 without
  // paying for a cryptographic hash per entry.
  const eventIdStream = entries.map(e => {
    const uuid = (e as { uuid?: unknown }).uuid;
    const id = typeof uuid === 'string' ? uuid : '';
    return `${e.type} ${id}`;
  });

  return {
    entries, skippedLines, fileSize: stat.size, formatRecognized,
    fileContentHash: lazyFileSha256(filePath, {
      size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino,
    }),
    eventIdStream, sessionId, sessionCwd, sessionName, thread,
  };
}
