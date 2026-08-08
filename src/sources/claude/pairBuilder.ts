import { contentHasOnlyToolResults } from '../../lib/contentFormatter.js';
import type {
  LogEntry,
  UserEntry,
  AssistantEntry,
  Pair,
  MessageContent,
} from '../../lib/types.js';

function isUserEntry(e: LogEntry): e is UserEntry {
  return e.type === 'user' && !!(e as UserEntry).message;
}

function isAssistantEntry(e: LogEntry): e is AssistantEntry {
  return e.type === 'assistant' && !!(e as AssistantEntry).message;
}

// A user message typed while the assistant is busy is stored as
// type=attachment / attachment.type="queued_command". Treat it as a new
// user question.
function asQueuedPromptUser(e: LogEntry): UserEntry | null {
  if (e.type !== 'attachment') return null;
  const att = (e as { attachment?: unknown }).attachment;
  if (!att || typeof att !== 'object') return null;
  const a = att as { type?: unknown; prompt?: unknown; commandMode?: unknown };
  if (a.type !== 'queued_command') return null;
  if (typeof a.prompt !== 'string') return null;
  if (a.commandMode !== undefined && a.commandMode !== 'prompt') return null;
  const re = e as { uuid?: string; parentUuid?: string | null; timestamp?: string; isSidechain?: boolean };
  return {
    type: 'user',
    message: { role: 'user', content: a.prompt },
    uuid: re.uuid ?? '',
    parentUuid: re.parentUuid ?? null,
    timestamp: re.timestamp ?? '',
    isSidechain: re.isSidechain ?? false,
  };
}

function getContentText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b.type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
        parts.push((b as { text: string }).text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function isSystemNoiseContent(content: MessageContent): boolean {
  const t = getContentText(content).trimStart();
  return (
    t.startsWith('<local-command-caveat>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<system-reminder>')
  );
}

function belongsToCurrentQuestion(e: UserEntry, current: Pair): boolean {
  if (!e.parentUuid) return false;
  if (e.parentUuid === current.questionEntry.uuid) return true;
  for (const extra of current.additionalQuestionEntries) {
    if (e.parentUuid === extra.uuid) return true;
  }
  return false;
}

// The human-readable session name Claude Code shows in its resume list.
// Custom title wins over AI title; the last value of each wins.
export function extractSessionName(entries: LogEntry[]): string {
  let aiTitle = '';
  let customTitle = '';
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'custom-title') {
      const v = (e as { customTitle?: unknown }).customTitle;
      if (typeof v === 'string' && v.trim() !== '') customTitle = v;
    } else if (e.type === 'ai-title') {
      const v = (e as { aiTitle?: unknown }).aiTitle;
      if (typeof v === 'string' && v.trim() !== '') aiTitle = v;
    }
  }
  return customTitle || aiTitle;
}

const COMMAND_NAME_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;

function slashCommandName(pair: Pair): string | null {
  const entries = [pair.questionEntry, ...pair.additionalQuestionEntries];
  for (const e of entries) {
    const t = getContentText(e.message?.content ?? '');
    const m = COMMAND_NAME_RE.exec(t);
    if (m) {
      const seg = m[1].split(/[/:]/).filter(Boolean).pop();
      if (seg) return seg;
    }
  }
  return null;
}

function commandFileContent(pair: Pair, name: string): string | null {
  const wantBase = `${name}.md`.toLowerCase();
  for (const e of pair.progressEntries) {
    const tur = (e as unknown as Record<string, unknown>).toolUseResult;
    if (!tur || typeof tur !== 'object') continue;
    const file = (tur as { file?: unknown }).file;
    if (!file || typeof file !== 'object') continue;
    const fp = (file as { filePath?: unknown }).filePath;
    const content = (file as { content?: unknown }).content;
    if (typeof fp !== 'string' || typeof content !== 'string') continue;
    const base = fp.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
    if (base === wantBase && /[\\/]commands[\\/]/i.test(fp)) {
      return content;
    }
  }
  return null;
}

// Restore slash-command bodies Claude Code truncated in the log: replace a
// stored body that is a strict, shorter prefix of the command file's text.
export function recoverSlashCommandBodies(pairs: Pair[]): void {
  for (const pair of pairs) {
    const name = slashCommandName(pair);
    if (!name) continue;
    const full = commandFileContent(pair, name);
    if (!full) continue;
    const fullKey = full.replace(/\s+$/g, '');
    for (const extra of pair.additionalQuestionEntries) {
      const t = getContentText(extra.message?.content ?? '');
      if (!t) continue;
      const tKey = t.replace(/\s+$/g, '');
      if (tKey.length < fullKey.length && fullKey.startsWith(tKey)) {
        extra.message.content = full;
        break;
      }
    }
  }
}

export interface BuildPairsOptions {
  includeSidechain?: boolean;
}

// Is this raw log entry part of a subagent (sidechain) conversation?
// Read straight off the entry, so a queued_command attachment — which carries
// the flag at the same top level — is classified like any other record.
function isSidechainEntry(e: LogEntry): boolean {
  return (e as { isSidechain?: unknown }).isSidechain === true;
}

/**
 * Split a session log into its main conversation and its subagent (sidechain)
 * conversation, each built as an INDEPENDENT stream.
 *
 * Building one interleaved stream — what `includeSidechain: true` used to do —
 * lets a sidechain record change the main conversation's pair boundaries: a
 * sidechain question opens a pair, and the parent's own next record (typically
 * the Task tool_result that closes the delegation) is then filed under it. That
 * makes "turn subagents on" a change to blocks that have nothing to do with
 * subagents, which spec §5.2 / §13 forbid — the new default must ADD subagent
 * blocks and leave every existing block and ccxlogid untouched.
 *
 * Partitioning first makes that invariant structural rather than incidental:
 * the main stream is exactly the record sequence the old default (subagents
 * hidden) processed, so it produces exactly the same pairs, and the subagent
 * pairs are additional.
 */
export function buildPairsSplit(entries: LogEntry[]): { main: Pair[]; subagent: Pair[] } {
  const mainEntries: LogEntry[] = [];
  const sidechainEntries: LogEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    (isSidechainEntry(e) ? sidechainEntries : mainEntries).push(e);
  }
  const subagent = sidechainEntries.length ? buildStream(sidechainEntries) : [];
  for (const p of subagent) p.isSubagent = true;
  return { main: buildStream(mainEntries), subagent };
}

export function buildPairs(entries: LogEntry[], options: BuildPairsOptions = {}): Pair[] {
  const { includeSidechain = false } = options;
  const { main, subagent } = buildPairsSplit(entries);
  return includeSidechain ? [...main, ...subagent] : main;
}

function buildStream(entries: LogEntry[]): Pair[] {
  const pairs: Pair[] = [];
  let current: Pair | null = null;

  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;

    const queued = asQueuedPromptUser(e);
    if (queued) {
      if (current && current.finalAssistantEntry) {
        pairs.push(current);
        current = null;
      }
      if (current === null) {
        current = {
          questionEntry: queued,
          additionalQuestionEntries: [],
          progressEntries: [],
          finalAssistantEntry: null,
        };
      } else {
        current.additionalQuestionEntries.push(queued);
      }
      continue;
    }

    if (isUserEntry(e)) {
      const content = e.message?.content;
      if (content === undefined || content === null) continue;

      if (e.isMeta) {
        if (
          current &&
          !current.finalAssistantEntry &&
          !isSystemNoiseContent(content) &&
          belongsToCurrentQuestion(e, current)
        ) {
          current.additionalQuestionEntries.push(e);
        }
        continue;
      }

      if (contentHasOnlyToolResults(content)) {
        if (current) current.progressEntries.push(e);
        continue;
      }

      // Real human question.
      if (current && current.finalAssistantEntry) {
        pairs.push(current);
        current = null;
      }

      if (current === null) {
        current = {
          questionEntry: e,
          additionalQuestionEntries: [],
          progressEntries: [],
          finalAssistantEntry: null,
        };
      } else if (e.parentUuid && e.parentUuid === current.questionEntry.parentUuid) {
        // Cancel and retype (a sibling fork from the same parentUuid): rather
        // than replacing it, finalise the pre-retype question as a standalone
        // pair with no answer, then start the new pair (v1.4.0 R1). This holds
        // repeatedly across an A->B->C run of cancellations.
        pairs.push(current);
        current = {
          questionEntry: e,
          additionalQuestionEntries: [],
          progressEntries: [],
          finalAssistantEntry: null,
        };
      } else {
        current.additionalQuestionEntries.push(e);
      }
      continue;
    }

    if (isAssistantEntry(e)) {
      if (!current) continue;
      if (current.finalAssistantEntry) {
        current.progressEntries.push(current.finalAssistantEntry);
      }
      current.finalAssistantEntry = e;
      continue;
    }
  }

  if (current) pairs.push(current);
  recoverSlashCommandBodies(pairs);
  return pairs;
}
