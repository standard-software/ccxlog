import { contentHasOnlyToolResults } from '../../lib/contentFormatter.js';
import type { AssistantEntry, LogEntry, Pair, UserEntry } from '../../lib/types.js';

function isUser(e: LogEntry): e is UserEntry {
  return e.type === 'user' && !!(e as UserEntry).message;
}

function isAssistant(e: LogEntry): e is AssistantEntry {
  return e.type === 'assistant' && !!(e as AssistantEntry).message;
}

export function extractSessionName(entries: LogEntry[]): string {
  let name = '';
  for (const entry of entries) {
    const value = (entry as Record<string, unknown>).sessionName
      ?? (entry as Record<string, unknown>).title;
    if (typeof value === 'string' && value.trim()) name = value;
  }
  return name;
}

// Build chronological Q&A pairs. task_complete is NOT the boundary: a real
// user message after ANY model activity (a final answer OR progress such as
// reasoning / tool calls) closes the previous pair. This matters for
// interrupted turns whose only model output is progress — without it the next
// question would be folded into the same pair and a pair would be lost.
// Multiple user messages before the first model response stay in one pair.
// Tool results are progress, never questions.
export function buildPairs(entries: LogEntry[]): Pair[] {
  const pairs: Pair[] = [];
  let current: Pair | null = null;

  for (const entry of entries) {
    if (isUser(entry)) {
      if (contentHasOnlyToolResults(entry.message.content)) {
        if (current) current.progressEntries.push(entry);
        continue;
      }
      if (current && (current.finalAssistantEntry || current.progressEntries.length > 0)) {
        pairs.push(current);
        current = null;
      }
      if (!current) {
        current = {
          questionEntry: entry,
          additionalQuestionEntries: [],
          progressEntries: [],
          finalAssistantEntry: null,
        };
      } else {
        current.additionalQuestionEntries.push(entry);
      }
      continue;
    }

    if (isAssistant(entry) && current) {
      if (entry.isProgressOnly) {
        current.progressEntries.push(entry);
        continue;
      }
      if (current.finalAssistantEntry) current.progressEntries.push(current.finalAssistantEntry);
      current.finalAssistantEntry = entry;
    }
  }

  if (current) pairs.push(current);
  return pairs;
}
