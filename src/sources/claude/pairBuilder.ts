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

export function buildPairs(entries: LogEntry[], options: BuildPairsOptions = {}): Pair[] {
  const { includeSidechain = false } = options;
  const pairs: Pair[] = [];
  let current: Pair | null = null;

  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;

    const queued = asQueuedPromptUser(e);
    if (queued) {
      if (queued.isSidechain && !includeSidechain) continue;
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
      if (e.isSidechain && !includeSidechain) continue;
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
        // Cancellation + retype: sibling forks from the same parent.
        current.questionEntry = e;
        current.additionalQuestionEntries = [];
      } else {
        current.additionalQuestionEntries.push(e);
      }
      continue;
    }

    if (isAssistantEntry(e)) {
      if (e.isSidechain && !includeSidechain) continue;
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
