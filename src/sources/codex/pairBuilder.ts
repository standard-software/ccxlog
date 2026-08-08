import { contentHasOnlyToolResults } from '../../lib/contentFormatter.js';
import type { AssistantEntry, LogEntry, Pair, UserEntry } from '../../lib/types.js';

function isUser(e: LogEntry): e is UserEntry {
  return e.type === 'user' && !!(e as UserEntry).message;
}

function isAssistant(e: LogEntry): e is AssistantEntry {
  return e.type === 'assistant' && !!(e as AssistantEntry).message;
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
      // A reply coming back UP from a subagent is the delegator's own result,
      // so it is progress inside the pair that delegated the work — never a
      // question. This is what makes a Codex delegation render like a Claude
      // one: there the Task result arrives as a tool_result and the parent's
      // block stays "human question -> final answer", whereas filing the reply
      // as a question split that block in two and left the parent's real answer
      // stranded on a block whose question was the machine text
      // `Message Type: FINAL_ANSWER ...`. It also stopped `includeSubagents:
      // false` from doing what its name promises, since the child's words were
      // still on show in the parent's copy.
      //
      // With no pair open there is nothing to attach to, so the reply keeps its
      // old behaviour and opens one — losing the record would be worse than an
      // odd-looking block, and a rollout can legitimately begin mid-delegation.
      if (entry.isDelegateReply && current) {
        current.progressEntries.push(entry);
        continue;
      }
      // An instruction handed to a subagent ALWAYS opens its own pair, even
      // when the pair before it has neither an answer nor any progress
      // (jsonlReader.ts sets isReceivedInstruction). Two things break without
      // this: an unanswered question inherited from the parent absorbs the
      // instruction, which changes the pair's replay identity and leaks the
      // inherited question back into the output; and two instructions arriving
      // back to back — which real parent rollouts contain — collapse into one
      // block.
      if (current && (entry.isReceivedInstruction
        || current.finalAssistantEntry || current.progressEntries.length > 0)) {
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
