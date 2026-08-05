import { extractLastAssistantText } from './contentFormatter.js';
import { sha256Hex } from './pathUtils.js';
import type { Pair, UserEntry } from './types.js';

// The replay identity of one Q&A pair.
//
// A Codex subagent rollout re-records the ENTIRE parent conversation at the top
// of the child's own file and rewrites each re-recorded line's outer timestamp
// to the child's start time. Neither the timestamp, the per-file positional
// uuid (`u-0`, `a-1`, …) nor the session id can therefore tell the two copies
// apart. A replay key is a file-independent identity for the user message(s)
// that open a pair, built from the only material the copies share:
//
//   1. `msg_…` — the response_item message-item id. Verified stable across
//      files (27 cross-file pairs, 0 text mismatches), but present on only a
//      minority of user items, so it cannot be the sole key.
//   2. `<turn_id>#<n>` — the turn id plus the message's index WITHIN that turn.
//      turn_id alone is not enough: real logs have 227 turns carrying more than
//      one user message and in 30 of them the texts differ, so keying on the
//      turn alone would erase a follow-up typed in the same turn.
//
// The choice is made PER MESSAGE — its `msg_…` id when it has one, its turn key
// otherwise — and the results are joined into ONE ordered key covering ALL of
// the pair's user messages (`questionEntry` + `additionalQuestionEntries`). A
// pair grouping two messages must not be confusable with a pair grouping only
// the first of them, and a pair where the two copies made different choices
// (id here, turn key there) must still line up — which it does, because the
// same message yields the same choice in both files whenever the id survives
// the re-recording, and falls back to the turn key in both when it does not.
//
// A pair in which even one user message yields neither form produces NO key,
// which means "cannot be proven a replay" and keeps the pair (§ requirement 5:
// keep anything unconfirmed).
//
// The key proves IDENTITY only. `textHash` — the ordered text of every user
// message — is the separate final confirmation the caller checks before
// treating a pair as a replay, so a key collision can never delete a
// differently-worded question.
export interface ReplayIdentity {
  key: string;
  textHash: string;
}

function contentText(entry: UserEntry): string {
  const content = entry.message.content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * Hashes of EVERY text this pair could show as its answer — the final assistant
 * message plus each earlier one that a later message pushed into the progress
 * list.
 *
 * A turn usually produces several assistant messages, and only the last of them
 * is rendered as the answer. A subagent spawned in the middle of a turn copies
 * the turn as far as it got, so its copy's LAST message is one of the ancestor's
 * INTERMEDIATE ones: the two copies disagree on the answer while describing the
 * same turn, and the ancestor holds strictly more. Measured on real logs, 4 of
 * the 21 apparent disagreements were this and the ancestor already held those
 * texts; the other 17 were answers the ancestor never gave. Comparing against
 * the full list is what tells the truncation apart from that genuine conflict,
 * where the child says something the ancestor never said and its block has to
 * be kept.
 */
export function answerTextHashes(pair: Pair): string[] {
  const out: string[] = [];
  const push = (text: string | null) => { if (text) out.push(sha256Hex(text)); };
  if (pair.finalAssistantEntry) push(extractLastAssistantText(pair.finalAssistantEntry.message.content));
  for (const entry of pair.progressEntries) {
    // Same filter buildAnswer() applies: reasoning and tool activity are never
    // an answer, so they must not make one pair look like it "already holds"
    // another's answer.
    if (entry.type !== 'assistant' || entry.isProgressOnly) continue;
    push(extractLastAssistantText(entry.message.content));
  }
  return out;
}

/**
 * One line per progress record, in order, describing what that record is —
 * enough to tell whether one copy's progress is contained in the other's.
 *
 * Two properties are required of it and neither is optional:
 *
 * 1. It must be IDENTICAL whether or not the template references Progress.
 *    `applyProgressRetention()` (lib/progressData.ts) strips the heavy payloads
 *    — tool inputs, tool results, reasoning — from every record as soon as the
 *    template does not ask for Progress, while keeping the records themselves,
 *    their order, their type, their top-level primitives and the assistant TEXT
 *    blocks. Comparing anything it strips would make the set of surviving
 *    blocks depend on the template: switching templates would move ccxlogids
 *    and force a backup, which is exactly the defect this generation must not
 *    inherit. So only what survives slimming is read here — which is why tool
 *    activity is identified by `progressKey` (a top-level string set at parse
 *    time) rather than by the tool blocks in `message.content`.
 * 2. It must not force Progress to be built. It is one short string per record,
 *    not the JSON serialisation of every tool call.
 */
export function progressSignatureOf(pair: Pair): string[] {
  const out: string[] = [];
  for (const entry of pair.progressEntries) {
    // An assistant record with text is identified by that text; tool calls,
    // tool results and reasoning by the id the model itself issued.
    const body = entry.progressKey
      ?? (entry.type === 'assistant' ? extractLastAssistantText(entry.message.content) : null);
    // A record with neither renders NOTHING in Progress (markdownWriter's
    // progressLinesFor returns no lines for it), so it is not progress content
    // and must not take part. The common case is the carrier a token_count
    // creates when the turn has no assistant message left to attach usage to:
    // an assistant entry with an empty content array. Those appear wherever a
    // usage report happened to land, which differs between a parent rollout
    // and a subagent's re-recording of it — leaving them in made two identical
    // lists of real progress look like divergent ones.
    if (!body) continue;
    out.push(`${entry.type}\0${entry.type === 'assistant' && entry.isProgressOnly ? 1 : 0}\0${body}`);
  }
  return out;
}

export function replayIdentityOf(pair: Pair): ReplayIdentity {
  const users = [pair.questionEntry, ...pair.additionalQuestionEntries];
  const parts: string[] = [];
  for (const u of users) {
    const part = u.replayMsgId ? `m:${u.replayMsgId}` : (u.replayTurnKey ? `t:${u.replayTurnKey}` : '');
    if (!part) return { key: '', textHash: '' };
    parts.push(part);
  }
  if (parts.length === 0) return { key: '', textHash: '' };
  return {
    key: sha256Hex(parts.join('\0')),
    textHash: sha256Hex(users.map(contentText).join('\0')),
  };
}
