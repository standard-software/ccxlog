import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { forEachLine } from '../../lib/lineStream.js';
import type { AssistantEntry, ContentBlock, LogEntry, UserEntry } from '../../lib/types.js';

export interface CodexReadResult {
  entries: LogEntry[];
  skippedLines: number;
  fileSize: number;
  fileContentHash: string;
  eventIdStreamHash: string[];
  sessionId: string;
  sessionCwd: string;
  sessionName: string;
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

// Injected context that reaches the log as a response_item user message but
// was never typed by the human — must not be recovered as a question.
const FALLBACK_NOISE_PREFIXES = ['<environment_context>', '<permissions', '<user_instructions', '<system-'];

function isFallbackNoise(value: string): boolean {
  const head = value.trimStart();
  return FALLBACK_NOISE_PREFIXES.some(prefix => head.startsWith(prefix));
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
//     is unverified and it is absent in observed logs (r5 report, cx5 §悪い点).
//   - a `payload.id` that does NOT match the known message-item id form is
//     rejected, so a future/foreign non-unique parent or turn id placed there can
//     never be mistaken for a per-item id and drop a genuine question.
// When no verified id is present — the real-world case for user messages — this
// returns '' and the caller keeps the message, honoring the spec's
// "確定できなければ残す" (§6.2).
function verifiedUserMessageId(payload: Raw): string {
  const id = text(payload.id);
  return id.startsWith('msg_') ? id : '';
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
function usageDelta(info: Raw, prevTotal: Raw | null): Raw | null {
  const total = info.total_token_usage;
  const last: Raw | null = info.last_token_usage ? raw(info.last_token_usage) : null;
  if (!total || typeof total !== 'object') return last;
  const totalRaw = total as Raw;
  // FIRST report: the delta from a zero baseline IS the whole cumulative total,
  // which may already cover several API calls made before this notification.
  // Crediting last_token_usage here (only the most recent call) undercounts, so
  // adopt the cumulative total (§6.2 "累積 total_token_usage の差分で計上").
  if (!prevTotal) return totalRaw;
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
  const pushUser = (content: string, timestamp: string): void => {
    const entry: UserEntry = {
      type: 'user', uuid: `u-${sequence++}`,
      message: { role: 'user', content }, ...common(timestamp),
    };
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

  const fileContentHash = await forEachLine(filePath, (line) => {
    if (!line.trim()) return;
    let event: Raw;
    try { event = JSON.parse(line) as Raw; } catch { skippedLines++; return; }
    const payload = raw(event.payload);
    const timestamp = text(event.timestamp);

    if (event.type === 'session_meta') {
      sessionId = text(payload.session_id) || text(payload.id) || sessionId;
      sessionName = text(payload.session_name) || text(payload.title) || sessionName;
      sessionCwd = text(payload.cwd) || sessionCwd;
      cwd = sessionCwd;
      version = text(payload.cli_version) || version;
      gitBranch = text(raw(payload.git).branch) || gitBranch;
      return;
    }
    if (event.type === 'turn_context') {
      turnId = text(payload.turn_id) || turnId;
      cwd = text(payload.cwd) || cwd;
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
      const usage = usageDelta(info, prevTotalUsage);
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
    if (itemType === 'message') {
      if (payload.role === 'user') {
        const value = messageText(payload.content);
        // Drop a fallback ONLY as a verified REPLAY: the same record re-serialized
        // into the rollout, proven by a repeat of its stable per-item message id
        // (verifiedUserMessageId — a `msg_…` payload.id). Without such a verified
        // id — the real-world case, where user response_items carry no id — keep
        // every message, even identical content at an identical timestamp, since
        // it may be a genuine repeated question (same text typed twice in the same
        // millisecond) and a resend and a real repeat are indistinguishable
        // without an id. This is the conservative "確定できなければ残す" of §6.2,
        // and never prunes on the ambiguous (timestamp, content) key (r5 report:
        // A の欠陥 = 正当な別発話の欠落 / B 方式 = ID ありのみ除外).
        if (value && !isFallbackNoise(value)) {
          const stableId = verifiedUserMessageId(payload);
          if (!stableId || !fallbackStableIds.has(stableId)) {
            fallbackUsers.push({ content: value, timestamp });
            if (stableId) fallbackStableIds.add(stableId);
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
      if (value) pushAssistant([{ type: 'thinking', thinking: value }], timestamp, true);
    } else if (itemType === 'custom_tool_call' || itemType === 'function_call') {
      // Tool calls are progress too — same reasoning as above.
      flushFallback();
      const id = text(payload.call_id) || text(payload.id);
      const name = text(payload.name) || 'unknown';
      const input = parseToolInput(payload.input ?? payload.arguments);
      pushAssistant([{ type: 'tool_use', id, name, input }], timestamp, true);
    } else if (itemType === 'custom_tool_call_output' || itemType === 'function_call_output') {
      const result: ContentBlock = {
        type: 'tool_result', tool_use_id: text(payload.call_id), content: outputText(payload.output),
      };
      const entry: UserEntry = {
        type: 'user', uuid: `r-${sequence++}`,
        message: { role: 'user', content: [result] }, ...common(timestamp),
      };
      entries.push(entry);
    }
  });

  // EOF: a turn whose only user input was a response_item fallback (no
  // task_started/agent_message/task_complete after it) still needs its
  // question emitted, so flush any pending fallbacks now (§6.2).
  flushFallback();

  const eventIdStreamHash = entries.map(e => {
    const uuid = (e as { uuid?: unknown }).uuid;
    const id = typeof uuid === 'string' ? uuid : '';
    return crypto.createHash('sha256').update(`${e.type} ${id}`).digest('hex').slice(0, 16);
  });

  return { entries, skippedLines, fileSize: stat.size, fileContentHash, eventIdStreamHash, sessionId, sessionCwd, sessionName };
}
