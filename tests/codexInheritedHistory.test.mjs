// Codex subagent rollouts: the parent conversation the CLI re-records into
// every child rollout must disappear, and NOTHING else may.
//
// EVERY record shape below was taken from real ~/.codex/sessions rollouts. That
// is not a detail: the previous attempt at this feature passed its whole test
// suite while never firing once on real data, because its fixtures invented
// shapes the CLI does not write. In particular —
//
//   - the inter-agent marker is the record's OUTER type, and its payload holds
//     nothing but { trigger_turn: true };
//   - the instruction is a response_item with payload.type 'agent_message'
//     (NOT 'message'), it has NO role field, and its content mixes an
//     input_text block with an encrypted_content blob;
//   - 6 of the 29 observed instructions carry no id at all, and the ones that
//     do use the `amsg_` prefix, not `msg_`;
//   - its turn id lives in internal_chat_message_metadata_passthrough;
//   - event_msg/agent_message is the SAME NAME for the opposite thing: the
//     child's own reply, of which the real logs hold 2,575.
//
// Anything that only works against a friendlier shape is a bug, so the fixtures
// here are the contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  mkTmp, rmrf, runCli, writeCodexSession, countPairs, writeConfig,
} from './helpers.mjs';

const watchTest = process.env.CCXLOG_SKIP_WATCH_TESTS === '1'
  ? (name, fn) => test(name, { skip: 'Run with npm run test:watch' }, fn)
  : test;

const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const CHILD2_ID = '33333333-3333-4333-8333-333333333333';

const PARENT_TS = '2026-05-27T10:00:00.000Z';
const CHILD_TS = '2026-05-27T12:00:00.000Z';
const CHILD2_TS = '2026-05-27T13:00:00.000Z';

// Shortened stand-in for the multi-kilobyte Base64 the real blocks carry.
const ENCRYPTED = 'gAAAAABqcYvqSHORTENED_FOR_THE_FIXTURE';

// ---------------------------------------------------------------------------
// Rollout record builders (real shapes)
// ---------------------------------------------------------------------------

function rootMeta(cwd, ts = PARENT_TS, id = PARENT_ID) {
  return {
    timestamp: ts, type: 'session_meta',
    payload: {
      id, session_id: id, cwd,
      cli_version: '0.144.6', git: { branch: 'parent-branch' },
      session_name: 'parent session',
    },
  };
}

// The child's own session_meta. `id` is the child thread (and the uuid in the
// file name), `session_id` is the PARENT — that inequality holds in 12/12 of
// the observed child rollouts and in 0/21 of the normal ones.
function subagentMeta(cwd, {
  id = CHILD_ID, sessionId = PARENT_ID, parentThreadId = PARENT_ID,
  ts = CHILD_TS, nickname = 'reviewer', forkedFrom = true, nestedNamesOnly = false,
} = {}) {
  const names = {
    agent_path: '.codex/agents/reviewer.md',
    ...(nickname ? { agent_nickname: nickname } : {}),
  };
  return {
    timestamp: ts, type: 'session_meta',
    payload: {
      id,
      session_id: sessionId,
      parent_thread_id: parentThreadId,
      thread_source: 'subagent',
      // Real payloads carry the names directly AND under
      // source.subagent.thread_spawn; nestedNamesOnly keeps just the nested one.
      source: { subagent: { thread_spawn: names } },
      ...(nestedNamesOnly ? {} : names),
      // 1 of the 12 observed child rollouts has no forked_from_id, so detection
      // must not depend on it.
      ...(forkedFrom ? { forked_from_id: sessionId } : {}),
      cwd, cli_version: '0.146.0', git: { branch: 'child-branch' },
    },
  };
}

function turn(turnId, ts, cwd) {
  return [
    { timestamp: ts, type: 'turn_context', payload: { turn_id: turnId, cwd, model: 'gpt-5' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
  ];
}

function userMsg(ts, message) {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message } };
}

// The response_item copy of a user message: the only copy carrying a `msg_…` id.
function userItem(ts, text, id) {
  return {
    timestamp: ts, type: 'response_item',
    payload: { type: 'message', role: 'user', ...(id ? { id } : {}), content: [{ type: 'input_text', text }] },
  };
}

// The child's OWN reply. Same payload name as an incoming instruction, opposite
// direction — 2,575 of these against 29 instructions in the real logs.
function agentMsg(ts, message) {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'agent_message', message } };
}

function taskComplete(ts, answer) {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: answer } };
}

// {"timestamp":…,"type":"inter_agent_communication_metadata","payload":{"trigger_turn":true}}
function marker(ts) {
  return { timestamp: ts, type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } };
}

// The instruction handed TO the subagent, exactly as recorded.
function instruction(ts, text, { id = 'amsg_019fcb8a-98fd-7071-be58-55cb5948e5e5', turnId = '', recipient = '/root/r1_review' } = {}) {
  return {
    timestamp: ts, type: 'response_item',
    payload: {
      type: 'agent_message',
      ...(id ? { id } : {}),
      author: '/root',
      recipient,
      content: [
        { type: 'input_text', text },
        { type: 'encrypted_content', encrypted_content: ENCRYPTED },
      ],
      ...(turnId ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } } : {}),
    },
  };
}

const NEW_TASK = 'Message Type: NEW_TASK\nTask name: /root/r1_review\nSender: /root\nPayload:\nReview the diff';
const FOLLOW_UP = 'Message Type: MESSAGE\nSender: /root\nPayload:\nAlso check the tests';

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

// The parent's conversation, re-stampable: the child re-records these very
// records with its own start time.
function parentHistory(ts, cwd, { answerLastTurn = false } = {}) {
  return [
    ...turn('turn-1', ts, cwd),
    userMsg(ts, 'Parent question one'),
    userItem(ts, 'Parent question one', 'msg_p1'),
    agentMsg(ts, 'Parent answer one'),
    taskComplete(ts, 'Parent answer one'),
    // Two DIFFERENT questions inside one turn (227 such turns in the real logs,
    // 30 of them with differing text). They form a single pair.
    ...turn('turn-2', ts, cwd),
    userMsg(ts, 'Parent question two-a'),
    userMsg(ts, 'Parent question two-b'),
    agentMsg(ts, 'Parent answer two'),
    taskComplete(ts, 'Parent answer two'),
    // The last turn is where the copies differ: the parent rollout stops after
    // the question, the child's re-recording also holds the answer.
    ...turn('turn-3', ts, cwd),
    userMsg(ts, 'Parent question three'),
    ...(answerLastTurn ? [agentMsg(ts, 'Parent answer three'), taskComplete(ts, 'Parent answer three')] : []),
  ];
}

function parentRollout(cwd) {
  return [rootMeta(cwd), ...parentHistory(PARENT_TS, cwd)];
}

function childTurns(cwd, ts) {
  return [
    // Marker and instruction arrive BEFORE the turn opens — which is why the
    // instruction's own turn id has to come out of the passthrough block.
    marker(ts),
    instruction(ts, NEW_TASK, { turnId: 'turn-child-1' }),
    ...turn('turn-child-1', ts, cwd),
    agentMsg(ts, 'Child answer to NEW_TASK'),
    taskComplete(ts, 'Child answer to NEW_TASK'),
    marker(ts),
    // 6 of 29 real instructions have no id: only the turn key identifies these.
    instruction(ts, FOLLOW_UP, { id: '', turnId: 'turn-child-2' }),
    ...turn('turn-child-2', ts, cwd),
    agentMsg(ts, 'Child answer to MESSAGE'),
    taskComplete(ts, 'Child answer to MESSAGE'),
  ];
}

// A child rollout: its own meta, the inherited replay (the parent's session_meta
// among it), then its own turns.
function childRollout(cwd, {
  id = CHILD_ID, ts = CHILD_TS, nickname = 'reviewer', forkedFrom = true,
  nestedNamesOnly = false, history = null, own = null, sessionId = PARENT_ID,
  parentThreadId = PARENT_ID,
} = {}) {
  return [
    subagentMeta(cwd, { id, ts, nickname, forkedFrom, nestedNamesOnly, sessionId, parentThreadId }),
    rootMeta(cwd, ts),                       // the replayed PARENT meta — must not win
    ...(history ?? parentHistory(ts, cwd, { answerLastTurn: true })),
    ...(own ?? childTurns(cwd, ts)),
  ];
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

function scaffold(t) {
  const home = mkTmp('ccx-cxinh-');
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const out = path.join(project, 'CCXLOG');
  if (t) t.after(() => rmrf(home));
  return { home, project, out };
}

function parentFileName() {
  return `rollout-2026-05-27T10-00-00-${PARENT_ID}.jsonl`;
}

function writeParent(s) {
  writeCodexSession(s.home, parentFileName(), parentRollout(s.project));
}

function writeChild(s, opts = {}) {
  const id = opts.id ?? CHILD_ID;
  writeCodexSession(s.home, `rollout-2026-05-27T12-00-00-${id}.jsonl`, childRollout(s.project, opts));
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

// Split a rendered document into per-pair blocks keyed by the block's ccxlogid.
function blocks(text) {
  return text.split(/(?=<!-- ccxlogid:[0-9a-f]{24} -->)/).filter(p => p.startsWith('<!-- ccxlogid:'));
}

function blocksContaining(text, needle) {
  return blocks(text).filter(b => b.includes(needle));
}

function blockContaining(text, needle) {
  const hit = blocksContaining(text, needle);
  assert.equal(hit.length, 1, `expected exactly one block containing ${JSON.stringify(needle)}, got ${hit.length}`);
  return hit[0];
}

function ids(text) {
  return text.match(/ccxlogid:[0-9a-f]{24}/g) ?? [];
}

function readOut(s, name = 'cxlog.md') {
  return fs.readFileSync(path.join(s.out, name), 'utf-8');
}

// ---------------------------------------------------------------------------
// P0-1 / requirement 3 — the received instruction, in its real shape
// ---------------------------------------------------------------------------

test('cx-inh 1: the real instruction shape is rendered as its own Q&A block', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s);

  const r = runCli([s.project, '-cx'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const text = readOut(s);

  // 3 parent pairs + 2 instruction pairs. Without the fix the child also
  // contributes its own copy of all 3 parent pairs.
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 5);

  // Both instructions survive, each carrying its own answer. Filtering on the
  // Message Type value would have dropped the MESSAGE one.
  assert.match(blockContaining(text, 'Message Type: NEW_TASK'), /Child answer to NEW_TASK/);
  assert.match(blockContaining(text, 'Message Type: MESSAGE'), /Child answer to MESSAGE/);

  // The encrypted_content block is not part of the question text.
  assert.doesNotMatch(text, /gAAAAAB/);
  assert.match(r.stdout, /Removed 3 pair\(s\) of parent history/);
});

test('cx-inh 2: an event_msg agent_message after the marker is the child speaking, not an instruction', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s, {
    own: [
      ...turn('turn-child-1', CHILD_TS, s.project),
      marker(CHILD_TS),
      // Same payload.type as an instruction but under event_msg: this is one of
      // the 2,575 replies the child itself made. Reading payload.type alone
      // would turn every one of them into a fake question.
      agentMsg(CHILD_TS, 'CHILD-OWN-SPEECH'),
      taskComplete(CHILD_TS, 'CHILD-OWN-SPEECH'),
    ],
  });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  // It may only appear as an answer, never as a question of its own.
  assert.equal(blocksContaining(text, 'CHILD-OWN-SPEECH').length, 1);
  assert.match(blockContaining(text, 'CHILD-OWN-SPEECH'), /## Answer[\s\S]*CHILD-OWN-SPEECH/);
});

test('cx-inh 3: a response_item agent_message with no marker in front is not a question', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s, {
    own: [
      ...turn('turn-child-1', CHILD_TS, s.project),
      instruction(CHILD_TS, 'NOT-AN-INSTRUCTION', { turnId: 'turn-child-1' }),
      marker(CHILD_TS),
      instruction(CHILD_TS, NEW_TASK, { turnId: 'turn-child-1' }),
      agentMsg(CHILD_TS, 'Child answer to NEW_TASK'),
      taskComplete(CHILD_TS, 'Child answer to NEW_TASK'),
    ],
  });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  assert.doesNotMatch(readOut(s), /NOT-AN-INSTRUCTION/);
});

test('cx-inh 4: an unanswered inherited question does not absorb the instruction that follows it', (t) => {
  const s = scaffold(t);
  writeParent(s);
  // The child's re-recording ends on the parent's UNANSWERED third question,
  // and the instruction is the very next record. If the instruction merely
  // joined that pair, the pair would no longer match the parent's copy, the
  // inherited question would survive in the child too, and the re-recording
  // this whole feature removes would leak back into the output.
  writeChild(s, {
    history: parentHistory(CHILD_TS, s.project),      // no answer on turn-3
    own: [
      marker(CHILD_TS),
      instruction(CHILD_TS, NEW_TASK, { turnId: 'turn-child-1' }),
      ...turn('turn-child-1', CHILD_TS, s.project),
      agentMsg(CHILD_TS, 'Child answer to NEW_TASK'),
      taskComplete(CHILD_TS, 'Child answer to NEW_TASK'),
    ],
  });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  assert.equal(occurrences(text, 'Parent question three'), 1, 'the inherited question must not be re-shown');
  const instructionBlock = blockContaining(text, 'Message Type: NEW_TASK');
  assert.doesNotMatch(instructionBlock, /Parent question three/);
  assert.match(instructionBlock, /Child answer to NEW_TASK/);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 4);   // 3 parent + 1 instruction
});

test('cx-inh 5: two instructions in a row stay two blocks', (t) => {
  const s = scaffold(t);
  writeParent(s);
  // Real parent rollouts hold marker pairs 2 to 8 lines apart. Nothing answers
  // the first instruction before the second arrives.
  writeChild(s, {
    own: [
      marker(CHILD_TS),
      instruction(CHILD_TS, NEW_TASK, { turnId: 'turn-child-1' }),
      marker(CHILD_TS),
      instruction(CHILD_TS, FOLLOW_UP, { id: '', turnId: 'turn-child-1' }),
      ...turn('turn-child-1', CHILD_TS, s.project),
      agentMsg(CHILD_TS, 'Child answer to both'),
      taskComplete(CHILD_TS, 'Child answer to both'),
    ],
  });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 5);   // 3 parent + 2 instructions
  const first = blockContaining(text, 'Message Type: NEW_TASK');
  assert.doesNotMatch(first, /Message Type: MESSAGE/);
  assert.match(blockContaining(text, 'Message Type: MESSAGE'), /Child answer to both/);
});

test('cx-inh 6: the Message Type value is never used to filter', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s, {
    own: [
      marker(CHILD_TS),
      // FINAL_ANSWER exists in the real logs alongside NEW_TASK and MESSAGE,
      // and further values may be added at any time.
      instruction(CHILD_TS, 'Message Type: FINAL_ANSWER\nSender: /root/r1_review\nPayload:\nDone', { turnId: 'turn-child-1' }),
      ...turn('turn-child-1', CHILD_TS, s.project),
      agentMsg(CHILD_TS, 'Acknowledged'),
      taskComplete(CHILD_TS, 'Acknowledged'),
    ],
  });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  assert.match(blockContaining(readOut(s), 'Message Type: FINAL_ANSWER'), /Acknowledged/);
});

// ---------------------------------------------------------------------------
// P0-3 / requirement 5 — what may be removed, and what must be merged
// ---------------------------------------------------------------------------

test('cx-inh 7: the parent keeps its own answer, and gains the one only the child had', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s);
  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);

  // The parent answered turns 1 and 2 itself: those answers stay, and the
  // child's re-recording of them may not replace anything.
  assert.match(blockContaining(text, 'Parent question one'), /Parent answer one/);
  assert.equal(occurrences(text, 'Parent answer one'), 1);
  // The parent rollout stops after question three; only the child's copy holds
  // the answer, so dropping that copy outright would lose it.
  assert.match(blockContaining(text, 'Parent question three'), /Parent answer three/);
  assert.equal(occurrences(text, 'Parent answer three'), 1);
});

test('cx-inh 8: a replay whose answer differs is KEPT, not silently dropped', (t) => {
  const s = scaffold(t);
  writeParent(s);
  // No marker anywhere: the child worked on its own, so its result hangs off
  // the last question it inherited. The pair is a confirmed replay by identity
  // AND by question text, yet the two copies answer differently — there is no
  // way to merge that, so the child's block survives and is reported.
  writeChild(s, {
    history: [
      // turn-1 is a turn the parent answered ITSELF, so the two answers
      // genuinely disagree — unlike turn-3, where the parent has none and the
      // child's answer is simply moved over.
      ...turn('turn-1', CHILD_TS, s.project),
      userMsg(CHILD_TS, 'Parent question one'),
      userItem(CHILD_TS, 'Parent question one', 'msg_p1'),
      agentMsg(CHILD_TS, 'CHILD-ONLY-RESULT'),
      taskComplete(CHILD_TS, 'CHILD-ONLY-RESULT'),
    ],
    own: [],
  });

  const r = runCli([s.project, '-cx'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const text = readOut(s);
  assert.match(text, /CHILD-ONLY-RESULT/);
  // The parent's own answer is untouched — the child's copy may not overwrite it.
  assert.match(blockContaining(text, 'Parent answer one'), /Parent question one/);
  assert.match(r.stdout, /kept 1 the original could not absorb/);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 4);   // 3 parent + the kept child copy

  // --verbose says WHICH of the two reasons it was, so a kept block can be
  // looked up without re-reading the logs.
  const v = runCli([s.project, '-cx', '--verbose'], { home: s.home });
  assert.equal(v.code, 0, v.stderr);
  assert.match(v.stdout, /kept \(differing answer .*Parent question one/);
});

test('cx-inh 8b: a copy that stops on an earlier message of the same turn is not a conflict', (t) => {
  const s = scaffold(t);
  // The parent's turn produced two assistant messages; only the last is the
  // rendered answer. The subagent was spawned between them, so its copy ends on
  // the first one. That is a truncation, not a disagreement: the ancestor
  // already holds both texts, so the child's copy adds nothing and goes.
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Long running question'),
    agentMsg(PARENT_TS, 'Interim progress note'),
    agentMsg(PARENT_TS, 'Final considered answer'),
    taskComplete(PARENT_TS, 'Final considered answer'),
  ]);
  writeChild(s, {
    history: [
      ...turn('turn-1', CHILD_TS, s.project),
      userMsg(CHILD_TS, 'Long running question'),
      agentMsg(CHILD_TS, 'Interim progress note'),
    ],
    own: [],
  });

  const r = runCli([s.project, '-cx'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const text = readOut(s);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 1);
  assert.match(blockContaining(text, 'Long running question'), /Final considered answer/);
  assert.doesNotMatch(r.stdout, /differing answer/);
});

test('cx-inh 9: history the parent no longer holds (compaction) is kept', (t) => {
  const s = scaffold(t);
  writeParent(s);
  // Spawned before the parent compacted, so the child still carries a turn the
  // parent rollout no longer has. Nothing can confirm it as a replay.
  writeChild(s, {
    history: [
      ...turn('turn-precompact', CHILD_TS, s.project),
      userMsg(CHILD_TS, 'Question lost to compaction'),
      agentMsg(CHILD_TS, 'Answer lost to compaction'),
      taskComplete(CHILD_TS, 'Answer lost to compaction'),
      ...parentHistory(CHILD_TS, s.project, { answerLastTurn: true }),
    ],
  });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  assert.match(text, /Question lost to compaction/);
  assert.match(text, /Answer lost to compaction/);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 6);   // 3 parent + 1 compacted + 2 child
});

test('cx-inh 10: a turn whose question list differs is not removed on the turn id alone', (t) => {
  const s = scaffold(t);
  writeParent(s);
  // Same turn id as the parent's two-question turn, but only the first message
  // reached the child. Keying on turn_id alone would call this a replay and
  // erase it; the ordered per-message key plus the text hash does not.
  writeChild(s, {
    history: [
      ...turn('turn-2', CHILD_TS, s.project),
      userMsg(CHILD_TS, 'Parent question two-a'),
      agentMsg(CHILD_TS, 'Parent answer two'),
      taskComplete(CHILD_TS, 'Parent answer two'),
    ],
  });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 6);   // 3 parent + 1 unconfirmed + 2 child
  assert.match(blockContaining(text, 'Parent question two-b'), /Parent question two-a/);
});

test('cx-inh 11: without the parent log in the project, nothing is removed', (t) => {
  const s = scaffold(t);
  writeChild(s);

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  // Nothing can be confirmed against an older copy, so the whole inherited
  // conversation stays rather than being guessed away.
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 5);
  assert.match(readOut(s), /Parent question one/);
});

// ---------------------------------------------------------------------------
// P0-4 / requirements 1-2 — identity
// ---------------------------------------------------------------------------

test('cx-inh 12: the replayed parent session_meta overrides no field of the child', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s);

  const r = runCli([s.project, '-cx', '--per-session'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const childText = fs.readFileSync(path.join(s.out, `cxlog_${CHILD_ID}.md`), 'utf-8');

  // Id and name: the child thread and its nickname, not the parent's id and
  // 'parent session'.
  assert.match(childText, new RegExp(`# CCXLog: \\[Codex\\] ${CHILD_ID}`));
  assert.match(childText, /reviewer/);
  assert.doesNotMatch(childText, /parent session/);
  // cli_version and git branch: the child's own, from its FIRST session_meta.
  // The old reader took the last one seen and reported the parent's.
  const block = blockContaining(childText, 'Message Type: NEW_TASK');
  assert.match(block, /0\.146\.0/);
  assert.match(block, /child-branch/);
  assert.doesNotMatch(block, /0\.144\.6/);
  assert.doesNotMatch(block, /parent-branch/);
});

test('cx-inh 13: source.subagent alone identifies the child, and the nested nickname is found', (t) => {
  const s = scaffold(t);
  writeParent(s);
  const rollout = childRollout(s.project, { nestedNamesOnly: true });
  delete rollout[0].payload.thread_source;   // only source.subagent is left
  writeCodexSession(s.home, `rollout-2026-05-27T12-00-00-${CHILD_ID}.jsonl`, rollout);

  const r = runCli([s.project, '-cx', '--per-session'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const childText = fs.readFileSync(path.join(s.out, `cxlog_${CHILD_ID}.md`), 'utf-8');
  assert.equal(countPairs(path.join(s.out, `cxlog_${CHILD_ID}.md`)), 2);
  assert.match(childText, /reviewer/);
});

test('cx-inh 14: a non-subagent rollout keeps the id and name it always had', (t) => {
  const s = scaffold(t);
  writeParent(s);

  const r = runCli([s.project, '-cx', '--per-session'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const file = path.join(s.out, `cxlog_${PARENT_ID}.md`);
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, 'utf-8'), /parent session/);
});

// ---------------------------------------------------------------------------
// P1 — replay key, ordering, lineage
// ---------------------------------------------------------------------------

test('cx-inh 15: the msg_ id identifies a replay when the turn does not survive', (t) => {
  const s = scaffold(t);
  writeParent(s);
  // The re-recording has no turn_context / task_started at all, so there is no
  // turn key — only the `msg_…` id, which the event_msg copy inherits from the
  // response_item copy.
  writeChild(s, {
    history: [
      userMsg(CHILD_TS, 'Parent question one'),
      userItem(CHILD_TS, 'Parent question one', 'msg_p1'),
      agentMsg(CHILD_TS, 'Parent answer one'),
      taskComplete(CHILD_TS, 'Parent answer one'),
    ],
  });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  assert.equal(occurrences(readOut(s), 'Parent question one'), 1);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 5);   // 3 parent + 2 child
});

test('cx-inh 16: the in-turn number counts rendered questions, not response_item copies', (t) => {
  const s = scaffold(t);
  // The parent records the event_msg copy first and the response_item copy
  // after it; the child's re-recording reverses that order and adds a second
  // response_item copy. Counting every copy would number the same message
  // differently in the two files and the replay would go unrecognised.
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Ordered question A'),
    userItem(PARENT_TS, 'Ordered question A'),
    userMsg(PARENT_TS, 'Ordered question B'),
    userItem(PARENT_TS, 'Ordered question B'),
    agentMsg(PARENT_TS, 'Parent answered both'),
    taskComplete(PARENT_TS, 'Parent answered both'),
  ]);
  writeChild(s, {
    history: [
      ...turn('turn-1', CHILD_TS, s.project),
      userItem(CHILD_TS, 'Ordered question A'),
      userMsg(CHILD_TS, 'Ordered question A'),
      userItem(CHILD_TS, 'Ordered question B'),
      userMsg(CHILD_TS, 'Ordered question B'),
      agentMsg(CHILD_TS, 'Parent answered both'),
      taskComplete(CHILD_TS, 'Parent answered both'),
    ],
  });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  assert.equal(occurrences(text, 'Ordered question A'), 1);
  assert.equal(occurrences(text, 'Ordered question B'), 1);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 3);   // 1 parent + 2 child
});

test('cx-inh 17: a grandchild is matched against the whole lineage', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s);
  // A subagent spawned BY the subagent: its lineage id is still the root, its
  // parent is the child. It replays the parent history AND the child's first
  // instruction — both are replays, only its own work is new.
  writeCodexSession(s.home, `rollout-2026-05-27T13-00-00-${CHILD2_ID}.jsonl`, [
    subagentMeta(s.project, {
      id: CHILD2_ID, sessionId: PARENT_ID, parentThreadId: CHILD_ID,
      ts: CHILD2_TS, nickname: 'grandchild',
    }),
    ...parentHistory(CHILD2_TS, s.project, { answerLastTurn: true }),
    marker(CHILD2_TS),
    instruction(CHILD2_TS, NEW_TASK, { turnId: 'turn-child-1' }),
    ...turn('turn-child-1', CHILD2_TS, s.project),
    agentMsg(CHILD2_TS, 'Child answer to NEW_TASK'),
    taskComplete(CHILD2_TS, 'Child answer to NEW_TASK'),
    marker(CHILD2_TS),
    instruction(CHILD2_TS, 'Message Type: NEW_TASK\nPayload:\nNow write the report', { id: 'amsg_gc', turnId: 'turn-gc-1' }),
    ...turn('turn-gc-1', CHILD2_TS, s.project),
    agentMsg(CHILD2_TS, 'Grandchild report'),
    taskComplete(CHILD2_TS, 'Grandchild report'),
  ]);

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 6);   // 3 parent + 2 child + 1 grandchild
  assert.equal(occurrences(text, 'Task name: /root/r1_review'), 1);
  assert.match(text, /Grandchild report/);
});

test('cx-inh 18: a child falls back to the lineage root when its direct parent is missing', (t) => {
  const s = scaffold(t);
  writeParent(s);
  // parent_thread_id names a rollout this project never sees (it was filtered
  // out by cwd). The lineage id still points at the root, so the replay is
  // recognised anyway.
  writeChild(s, { parentThreadId: '99999999-9999-4999-8999-999999999999' });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 5);
  assert.equal(occurrences(readOut(s), 'Parent question one'), 1);
});

test('cx-inh 19: the verdict does not depend on the order the log roots are scanned', (t) => {
  const s = scaffold(t);
  const dirA = path.join(s.home, 'logs-a');
  const dirB = path.join(s.home, 'logs-b');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(path.join(dirA, 'parent.jsonl'),
    parentRollout(s.project).map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  fs.writeFileSync(path.join(dirB, 'child.jsonl'),
    childRollout(s.project).map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

  const outA = path.join(s.home, 'out-a');
  const outB = path.join(s.home, 'out-b');
  writeConfig(outA, { codex: { extraLogDirs: [{ dir: dirA, key: 'a' }, { dir: dirB, key: 'b' }] } });
  writeConfig(outB, { codex: { extraLogDirs: [{ dir: dirB, key: 'b' }, { dir: dirA, key: 'a' }] } });

  assert.equal(runCli([s.project, '-cx', '--out', outA], { home: s.home }).code, 0);
  assert.equal(runCli([s.project, '-cx', '--out', outB], { home: s.home }).code, 0);
  assert.equal(
    fs.readFileSync(path.join(outA, 'cxlog.md'), 'utf-8'),
    fs.readFileSync(path.join(outB, 'cxlog.md'), 'utf-8'),
  );
});

// ---------------------------------------------------------------------------
// Requirements 8-11 — output modes, ids, verification
// ---------------------------------------------------------------------------

test('cx-inh 20: per-session writes one file per thread and agrees with aggregate', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s);
  writeChild(s, { id: CHILD2_ID, ts: CHILD2_TS, nickname: 'tester', forkedFrom: false });

  // Before the id split both children were filed under the parent's id and the
  // run died on the filename collision.
  const r = runCli([s.project, '-cx', '--per-session'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);

  const written = fs.readdirSync(s.out).filter(f => f.startsWith('cxlog_')).sort();
  assert.deepEqual(written, [
    `cxlog_${PARENT_ID}.md`, `cxlog_${CHILD_ID}.md`, `cxlog_${CHILD2_ID}.md`,
  ].sort());

  const parentText = fs.readFileSync(path.join(s.out, `cxlog_${PARENT_ID}.md`), 'utf-8');
  const childText = fs.readFileSync(path.join(s.out, `cxlog_${CHILD_ID}.md`), 'utf-8');
  assert.equal(countPairs(path.join(s.out, `cxlog_${PARENT_ID}.md`)), 3);
  assert.equal(countPairs(path.join(s.out, `cxlog_${CHILD_ID}.md`)), 2);
  assert.doesNotMatch(childText, /Parent question one/);
  // Same verdict as aggregate: the merge ran before the mode was chosen.
  assert.match(blockContaining(parentText, 'Parent question three'), /Parent answer three/);
});

test('cx-inh 21: aggregate and per-session keep exactly the same pairs', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s);
  writeChild(s, { id: CHILD2_ID, ts: CHILD2_TS, nickname: 'tester' });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const aggregate = ids(readOut(s));

  assert.equal(runCli([s.project, '-cx', '--per-session'], { home: s.home }).code, 0);
  const perSession = fs.readdirSync(s.out)
    .filter(f => f.startsWith('cxlog_') && f.endsWith('.md'))
    .flatMap(f => ids(fs.readFileSync(path.join(s.out, f), 'utf-8')));

  assert.deepEqual([...aggregate].sort(), [...perSession].sort());
});

// The file the OLD naming produced for a subagent: filed under the parent's id
// (so the parent's owner marker), but generated FROM the child's rollout. That
// second half is what makes it identifiable, and the two tests below turn on it.
function forgeLegacyFile(s, childId = CHILD_ID) {
  const file = path.join(s.out, `cxlog_${PARENT_ID}.md`);
  const childLog = path.join(
    s.home, '.codex', 'sessions', '2026', '05', '27', `rollout-2026-05-27T12-00-00-${childId}.jsonl`,
  );
  const text = fs.readFileSync(file, 'utf-8').replace(/^- Source: .*$/m, `- Source: ${childLog}`);
  fs.writeFileSync(file, text, 'utf-8');
  return file;
}

test('cx-inh 22: the file a subagent used to be filed under is not left behind', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s);
  assert.equal(runCli([s.project, '-cx', '--per-session'], { home: s.home }).code, 0);
  const legacy = forgeLegacyFile(s);

  // The parent rollout leaves the project (rotated away, or excluded by cwd),
  // so nothing claims that name any more. The file itself records that it was
  // generated from the CHILD's log — under the old naming the child WAS that
  // file — so it is this subagent's own output under its former name and
  // leaving it behind would keep showing the same conversation twice.
  fs.rmSync(path.join(s.home, '.codex', 'sessions', '2026', '05', '27', parentFileName()));

  const r = runCli([s.project, '-cx', '--per-session'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(legacy), 'the superseded name must go');
  assert.ok(fs.existsSync(path.join(s.out, `cxlog_${CHILD_ID}.md`)));
  assert.match(r.stdout, /superseded name/);
  // Removing a file loses its ccxlogids, so it is backed up first (v1.4.0 R2).
  const backupRoot = path.join(s.out, 'backup_CCXLOG_md_auto');
  const copies = fs.readdirSync(backupRoot).flatMap(d => fs.readdirSync(path.join(backupRoot, d)));
  assert.ok(copies.includes(`cxlog_${PARENT_ID}.md`), 'the removed file must be backed up');
});

test('cx-inh 22b: a live parent session\'s own file is NOT removed when it drops out of a run', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s);
  assert.equal(runCli([s.project, '-cx', '--per-session'], { home: s.home }).code, 0);
  const parentFile = path.join(s.out, `cxlog_${PARENT_ID}.md`);
  const before = fs.readFileSync(parentFile, 'utf-8');

  // Same disappearance as cx-inh 22 — the parent rollout is no longer part of
  // this run — but here the file is the PARENT's own output, written from the
  // parent's own log. It is indistinguishable from the leftover by session id
  // alone: both are named cxlog_<parent>.md and both carry the parent's marker.
  // Deleting it because "no session in this run has that id" would destroy a
  // live session's output every time a cwd filter, a narrower extraCwds or a
  // different --out temporarily hides the parent, which is the one thing this
  // clean-up must never do.
  fs.rmSync(path.join(s.home, '.codex', 'sessions', '2026', '05', '27', parentFileName()));

  const r = runCli([s.project, '-cx', '--per-session', '--verbose'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(parentFile, 'utf-8'), before, 'the parent\'s own file must survive');
  // Kept, and said so — a user asking why the stale-looking file is still there
  // gets an answer without reading the code.
  assert.match(r.stdout, /superseded name \(kept: not provably this session's own output\)/);
  // The child's own file is rewritten this run (with the parent gone, the pairs
  // it used to inherit can no longer be confirmed as replays, so they stay and
  // its ccxlogids move) and that rewrite is backed up. The parent's file is
  // not: it was never touched.
  const backupRoot = path.join(s.out, 'backup_CCXLOG_md_auto');
  const copies = fs.existsSync(backupRoot)
    ? fs.readdirSync(backupRoot).flatMap(d => fs.readdirSync(path.join(backupRoot, d)))
    : [];
  assert.ok(!copies.includes(`cxlog_${PARENT_ID}.md`), 'the parent file must not even be backed up');
});

test('cx-inh 23: a file still owned by a live session is never taken for a leftover', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s);
  assert.equal(runCli([s.project, '-cx', '--per-session'], { home: s.home }).code, 0);
  const first = fs.readFileSync(path.join(s.out, `cxlog_${PARENT_ID}.md`), 'utf-8');

  const r = runCli([s.project, '-cx', '--per-session'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(s.out, `cxlog_${PARENT_ID}.md`), 'utf-8'), first);
  assert.doesNotMatch(r.stdout, /superseded name/);
});

test('cx-inh 24: surviving pairs keep the parent identity, so their ccxlogids do not move', (t) => {
  const s = scaffold(t);
  writeParent(s);
  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const before = ids(readOut(s));
  assert.equal(before.length, 3);

  // Adding the subagent rollout must not disturb a single existing id: what
  // survives is the parent's copy, merged into, never replaced.
  writeChild(s);
  const r = runCli([s.project, '-cx'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const after = readOut(s);
  for (const id of before) assert.ok(after.includes(id), `${id} must survive`);
  assert.doesNotMatch(r.stdout, /Backed up/);
  assert.ok(!fs.existsSync(path.join(s.out, 'backup_CCXLOG_md_auto')), 'no id was lost, so no backup');
});

test('cx-inh 25: a second run is a complete noop', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s);

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const first = readOut(s);
  const r = runCli([s.project, '-cx'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\[noop\]/);
  assert.equal(readOut(s), first);
});

watchTest('cx-inh 26: watch reaches the same bytes as a single run and then stops changing', (t) => {
  const s = scaffold(t);
  writeParent(s);
  writeChild(s);

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const single = readOut(s);

  const watchOut = path.join(s.home, 'watch-out');
  writeConfig(watchOut, { watchIntervalSeconds: 1 });
  const r = runCli([s.project, '-cx', '--out', watchOut, '--watch=2s'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  // Cycle 1 creates the file; every later cycle reuses the cached parse and
  // must land on exactly the same bytes.
  assert.equal(fs.readFileSync(path.join(watchOut, 'cxlog.md'), 'utf-8'), single);
  assert.match(r.stdout, /writes: 1 create, 0 append, 0 rewrite/);
});

test('cx-inh 27: attributed injected-context tags are not rendered as questions', (t) => {
  const s = scaffold(t);
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    userItem(PARENT_TS, '<codex_internal_context source="goal">\nsubagent bookkeeping\n</codex_internal_context>'),
    userItem(PARENT_TS, '<recommended_plugins source="system">\nplugin list\n</recommended_plugins>'),
    userItem(PARENT_TS, '<codex_internal_contextual>must remain</codex_internal_contextual>'),
    userItem(PARENT_TS, '<recommended_plugins_extra>must also remain</recommended_plugins_extra>'),
    userItem(PARENT_TS, 'A real question'),
    agentMsg(PARENT_TS, 'A real answer'),
    taskComplete(PARENT_TS, 'A real answer'),
  ]);

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 1);
  assert.doesNotMatch(text, /subagent bookkeeping/);
  assert.doesNotMatch(text, /plugin list/);
  assert.match(text, /codex_internal_contextual/);
  assert.match(text, /recommended_plugins_extra/);
  assert.match(text, /A real question/);
});

// ---------------------------------------------------------------------------
// Generation 3 — field-level completion, and the two ways it may NOT decide
// which blocks survive
// ---------------------------------------------------------------------------

// A token_count record. The reader credits the DELTA of the cumulative counter,
// and the first report in a file is credited whole, so one record per file
// yields exactly these numbers.
function tokenCount(ts, { input = 0, output = 0, cached = 0, reasoning = 0 } = {}) {
  return {
    timestamp: ts, type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input, output_tokens: output,
          cached_input_tokens: cached, reasoning_output_tokens: reasoning,
        },
      },
    },
  };
}

// A tool call and its result, as response_items. `call_id` is the model's own,
// so the parent's record of a call and the child's re-recording of that SAME
// call carry the same one — which is what lets the two progress lists be
// compared without rendering them (and therefore without the template getting
// a say in which blocks survive).
function toolCall(ts, callId, name = 'shell', args = '{"cmd":"ls"}') {
  return {
    timestamp: ts, type: 'response_item',
    payload: { type: 'function_call', call_id: callId, name, arguments: args },
  };
}

function toolResult(ts, callId, output = 'ok') {
  return {
    timestamp: ts, type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, output },
  };
}

// The same document, once with Progress and once without. Only the rendering
// differs; which pairs exist must not.
const PROGRESS_TEMPLATE = '<!-- %CcxlogId% -->\n# %DateTime%   [%Source%] Session:%SessionName%:%SessionId%\n## Question\n%Question%\n## Progress\n%ProgressFull%\n## Answer\n%Answer%\n\n----------------------------------------\n\n';
const PLAIN_TEMPLATE = '<!-- %CcxlogId% -->\n# %DateTime%   [%Source%] Session:%SessionName%:%SessionId%\n## Question\n%Question%\n## Answer\n%Answer%\n\n----------------------------------------\n\n';

// `template` in the config names a FILE, resolved relative to the output dir.
function useTemplate(s, body) {
  const rel = path.join('templates', 'probe.md');
  fs.mkdirSync(path.join(s.out, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(s.out, rel), body, 'utf-8');
  writeConfig(s.out, { template: rel.split(path.sep).join('/') });
}

test('cx-inh 28: token totals are completed field by field with the LARGER value', (t) => {
  const s = scaffold(t);
  // One turn, identical question and answer in both copies. The parent recorded
  // it while the turn was still running and holds a partial count; the child
  // re-recorded the finished turn. Neither copy is larger in every field, so
  // "take the copy with more" would be wrong too — the completion has to be per
  // field.
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Parent question one'),
    userItem(PARENT_TS, 'Parent question one', 'msg_p1'),
    agentMsg(PARENT_TS, 'Parent answer one'),
    taskComplete(PARENT_TS, 'Parent answer one'),
    tokenCount(PARENT_TS, { input: 50, output: 1, cached: 7, reasoning: 0 }),
  ]);
  writeChild(s, {
    history: [
      // The counter the re-recording opens with belongs to the parent, so the
      // first report of a subagent file is a baseline and not a credit
      // (cx-inh 35). Zero here, which makes the next report a clean delta.
      tokenCount(CHILD_TS, {}),
      ...turn('turn-1', CHILD_TS, s.project),
      userMsg(CHILD_TS, 'Parent question one'),
      userItem(CHILD_TS, 'Parent question one', 'msg_p1'),
      agentMsg(CHILD_TS, 'Parent answer one'),
      taskComplete(CHILD_TS, 'Parent answer one'),
      tokenCount(CHILD_TS, { input: 5, output: 200, cached: 3, reasoning: 9 }),
    ],
    own: [],
  });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const block = blockContaining(readOut(s), 'Parent question one');
  // in: the parent's 50 kept; out: the child's 200 taken; cache read: 7 kept;
  // reasoning: 9 taken. "Fill only what is undefined" would report out 1.
  assert.match(block, /Tokens=in 50, out 200, cache read 7, reasoning 9/);
  // A field NEITHER copy reported is not invented, so undefined stays
  // distinguishable from a reported 0 (Codex never reports cache writes).
  assert.doesNotMatch(block, /cache write/);
});

test('cx-inh 29: progress the original does not contain keeps the child pair', (t) => {
  const s = scaffold(t);
  // Same question, same rendered answer, but the two copies did different work
  // in between: neither tool list contains the other. Replacing the original's
  // progress with the child's would drop `call-parent-only`; dropping the child
  // pair would drop `call-child-only`. So the child pair is kept and reported.
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Parent question one'),
    userItem(PARENT_TS, 'Parent question one', 'msg_p1'),
    toolCall(PARENT_TS, 'call-shared'),
    toolResult(PARENT_TS, 'call-shared'),
    toolCall(PARENT_TS, 'call-parent-only'),
    toolResult(PARENT_TS, 'call-parent-only'),
    agentMsg(PARENT_TS, 'Parent answer one'),
    taskComplete(PARENT_TS, 'Parent answer one'),
  ]);
  writeChild(s, {
    history: [
      ...turn('turn-1', CHILD_TS, s.project),
      userMsg(CHILD_TS, 'Parent question one'),
      userItem(CHILD_TS, 'Parent question one', 'msg_p1'),
      toolCall(CHILD_TS, 'call-shared'),
      toolResult(CHILD_TS, 'call-shared'),
      toolCall(CHILD_TS, 'call-child-only'),
      toolResult(CHILD_TS, 'call-child-only'),
      agentMsg(CHILD_TS, 'Parent answer one'),
      taskComplete(CHILD_TS, 'Parent answer one'),
    ],
    own: [],
  });

  const r = runCli([s.project, '-cx', '--verbose'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 2);
  assert.match(r.stdout, /kept 1 the original could not absorb/);
  assert.match(r.stdout, /kept \(differing progress .*Parent question one/);
});

test('cx-inh 30: a copy whose progress CONTAINS the original one moves over', (t) => {
  const s = scaffold(t);
  // The parent's turn was interrupted after one tool call; the child holds the
  // whole thing and ends on the same answer. The parent's list is a subsequence
  // of the child's, so taking the child's loses nothing — and the block that
  // survives is still the parent's.
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Parent question one'),
    userItem(PARENT_TS, 'Parent question one', 'msg_p1'),
    toolCall(PARENT_TS, 'call-a', 'shell', '{"cmd":"step one"}'),
    toolResult(PARENT_TS, 'call-a'),
    agentMsg(PARENT_TS, 'Parent answer one'),
    taskComplete(PARENT_TS, 'Parent answer one'),
  ]);
  writeChild(s, {
    history: [
      ...turn('turn-1', CHILD_TS, s.project),
      userMsg(CHILD_TS, 'Parent question one'),
      userItem(CHILD_TS, 'Parent question one', 'msg_p1'),
      toolCall(CHILD_TS, 'call-a', 'shell', '{"cmd":"step one"}'),
      toolResult(CHILD_TS, 'call-a'),
      toolCall(CHILD_TS, 'call-b', 'shell', '{"cmd":"step two"}'),
      toolResult(CHILD_TS, 'call-b'),
      agentMsg(CHILD_TS, 'Parent answer one'),
      taskComplete(CHILD_TS, 'Parent answer one'),
    ],
    own: [],
  });

  // Rendered with a Progress-referencing template so the merged progress is
  // actually visible.
  useTemplate(s, PROGRESS_TEMPLATE);
  const r = runCli([s.project, '-cx'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 1);
  const text = readOut(s);
  assert.match(text, /step one/);
  assert.match(text, /step two/, 'the fuller progress moved into the surviving pair');
  assert.doesNotMatch(r.stdout, /could not absorb/);
});


test('cx-inh 31: which blocks survive does not depend on the template', (t) => {
  // The defect this pins down: deciding what to keep by comparing RENDERED
  // Progress makes the answer depend on whether the template asks for Progress
  // at all, because the retention pass empties it when it does not. Changing a
  // template would then add or remove blocks — and lose the ccxlogids of the
  // ones that went, forcing an automatic backup on a pure display change.
  const idsFor = (template) => {
    const s = scaffold(t);
    // A mix of every shape the decision turns on: identical replays, a copy
    // truncated mid-turn, and progress on both sides of the same turn.
    writeCodexSession(s.home, parentFileName(), [
      rootMeta(s.project),
      ...turn('turn-0', PARENT_TS, s.project),
      userMsg(PARENT_TS, 'Long running question'),
      toolCall(PARENT_TS, 'call-a'),
      toolResult(PARENT_TS, 'call-a'),
      agentMsg(PARENT_TS, 'Interim progress note'),
      agentMsg(PARENT_TS, 'Final considered answer'),
      taskComplete(PARENT_TS, 'Final considered answer'),
      ...parentHistory(PARENT_TS, s.project),
    ]);
    writeChild(s, {
      history: [
        ...turn('turn-0', CHILD_TS, s.project),
        userMsg(CHILD_TS, 'Long running question'),
        toolCall(CHILD_TS, 'call-a'),
        toolResult(CHILD_TS, 'call-a'),
        agentMsg(CHILD_TS, 'Interim progress note'),
        ...parentHistory(CHILD_TS, s.project, { answerLastTurn: true }),
      ],
      own: [],
    });
    useTemplate(s, template);
    assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
    return [...ids(readOut(s))].sort();
  };

  assert.deepEqual(idsFor(PROGRESS_TEMPLATE), idsFor(PLAIN_TEMPLATE));
});

test('cx-inh 32: a later session_meta still wins for a NORMAL session', (t) => {
  const s = scaffold(t);
  // § requirement 2 fixes the FIRST session_meta as authoritative because a
  // subagent rollout replays its parent's. That is a statement about subagent
  // rollouts. A resumed normal session writes a fresh meta precisely BECAUSE
  // its metadata changed, and the baseline showed the newer value; nothing in
  // the requirement asks for that to change, so it does not.
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Before the resume'),
    agentMsg(PARENT_TS, 'Answer before'),
    taskComplete(PARENT_TS, 'Answer before'),
    // Resumed: a second meta with a DIFFERENT non-empty value in every field.
    {
      timestamp: PARENT_TS, type: 'session_meta',
      payload: {
        id: PARENT_ID, session_id: PARENT_ID, cwd: s.project,
        cli_version: '0.200.0', git: { branch: 'resumed-branch' },
        session_name: 'resumed session',
      },
    },
    ...turn('turn-2', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'After the resume'),
    agentMsg(PARENT_TS, 'Answer after'),
    taskComplete(PARENT_TS, 'Answer after'),
  ]);

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  assert.match(text, /resumed session/);
  assert.doesNotMatch(text, /parent session/);
  const after = blockContaining(text, 'After the resume');
  assert.match(after, /0\.200\.0/);
  assert.match(after, /resumed-branch/);
  // The turn recorded BEFORE the second meta still shows what was true then.
  const before = blockContaining(text, 'Before the resume');
  assert.match(before, /0\.144\.6/);
  assert.match(before, /parent-branch/);
});

test('cx-inh 33: an instruction takes its turn id from the passthrough, not the running turn', (t) => {
  const s = scaffold(t);
  // The instruction is recorded BEFORE the turn_context that opens its turn, so
  // at that moment the reader's running turn id still names the PREVIOUS turn.
  // Here the two copies were preceded by DIFFERENT turns, so a key built from
  // the running turn id would differ between them and the replay would go
  // unrecognised. The instruction also carries no id, so only the turn key can
  // identify it — which is the point.
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-earlier', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Something earlier'),
    agentMsg(PARENT_TS, 'Answer earlier'),
    taskComplete(PARENT_TS, 'Answer earlier'),
    marker(PARENT_TS),
    instruction(PARENT_TS, NEW_TASK, { id: '', turnId: 'turn-passthrough' }),
    ...turn('turn-passthrough', PARENT_TS, s.project),
    agentMsg(PARENT_TS, 'Answer to the instruction'),
    taskComplete(PARENT_TS, 'Answer to the instruction'),
  ]);
  writeChild(s, {
    history: [
      ...turn('turn-elsewhere', CHILD_TS, s.project),
      userMsg(CHILD_TS, 'Something else entirely'),
      agentMsg(CHILD_TS, 'Answer elsewhere'),
      taskComplete(CHILD_TS, 'Answer elsewhere'),
      marker(CHILD_TS),
      instruction(CHILD_TS, NEW_TASK, { id: '', turnId: 'turn-passthrough' }),
      ...turn('turn-passthrough', CHILD_TS, s.project),
      agentMsg(CHILD_TS, 'Answer to the instruction'),
      taskComplete(CHILD_TS, 'Answer to the instruction'),
    ],
    own: [],
  });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  assert.equal(
    occurrences(text, 'Message Type: NEW_TASK'), 1,
    'the re-recorded instruction is a replay of the parent\'s and goes',
  );
  // The child's own unrelated turn is untouched.
  assert.match(text, /Something else entirely/);
});

test('cx-inh 34: a real question later in the same turn as an instruction is not lost', (t) => {
  const s = scaffold(t);
  // Reading an instruction must NOT set the "this turn already produced a user
  // message" flag: the instruction is not a response_item user message and can
  // never be recovered as a fallback, so setting it only suppresses a genuine
  // fallback question arriving later in the same turn.
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    marker(PARENT_TS),
    instruction(PARENT_TS, NEW_TASK, { turnId: 'turn-1' }),
    // No event_msg/user_message for this turn, so the response_item copy is the
    // only record of what the human typed.
    userItem(PARENT_TS, 'A question typed after the instruction', 'msg_after'),
    agentMsg(PARENT_TS, 'Answer to both'),
    taskComplete(PARENT_TS, 'Answer to both'),
  ]);

  const r = runCli([s.project, '-cx'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const text = readOut(s);
  // Setting the flag on the instruction would suppress the recovery entirely
  // and this line would be nowhere in the output.
  assert.match(text, /A question typed after the instruction/);
  assert.match(text, /Message Type: NEW_TASK/);
  // They share one block: the instruction opened a pair, nothing answered it
  // yet, so the question that followed joins it as a steering follow-up. That
  // is the normal grouping for two user messages with no answer between them —
  // what matters here is that the second one still exists.
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 1);
  assert.match(blockContaining(text, 'Message Type: NEW_TASK'), /A question typed after the instruction/);
});

test('cx-inh 35: a subagent\'s first token_count is a baseline, not this turn\'s usage', (t) => {
  const s = scaffold(t);
  // Usage is credited as the DELTA of a cumulative counter, and the FIRST
  // report in a file is credited whole — it covers the calls made before the
  // first notification. A subagent rollout breaks that assumption: it opens
  // with the parent's conversation re-recorded from wherever it had got to, so
  // its first counter is the PARENT's running total. Crediting it whole put
  // 31,643,877 input tokens on a single question in the real logs, against the
  // 142,977 that turn actually used.
  //
  // The child here re-records one turn and its first report claims a huge
  // cumulative total, then a second report moves it a little.
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Parent question one'),
    userItem(PARENT_TS, 'Parent question one', 'msg_p1'),
    agentMsg(PARENT_TS, 'Parent answer one'),
    taskComplete(PARENT_TS, 'Parent answer one'),
    tokenCount(PARENT_TS, { input: 100, output: 10 }),
  ]);
  writeChild(s, {
    history: [
      ...turn('turn-1', CHILD_TS, s.project),
      userMsg(CHILD_TS, 'Parent question one'),
      userItem(CHILD_TS, 'Parent question one', 'msg_p1'),
      agentMsg(CHILD_TS, 'Parent answer one'),
      taskComplete(CHILD_TS, 'Parent answer one'),
      tokenCount(CHILD_TS, { input: 9_000_000, output: 8_000 }),
      tokenCount(CHILD_TS, { input: 9_000_040, output: 8_002 }),
    ],
    own: [],
  });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const block = blockContaining(readOut(s), 'Parent question one');
  // The parent's own 100/10 stands. The child contributes only the 40/2 its
  // second report actually moved the counter by, which is smaller, so the
  // field-wise completion of cx-inh 28 leaves the parent's numbers alone.
  assert.match(block, /Tokens=in 100, out 10/);
  assert.doesNotMatch(block, /9,000,000/);
});

test('cx-inh 36: a normal session still credits its first token_count whole', (t) => {
  const s = scaffold(t);
  // The rule above is about subagent rollouts only. An ordinary session starts
  // its own count, so the first cumulative total is genuinely its own usage and
  // is credited in full — unchanged from the baseline behaviour.
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Parent question one'),
    agentMsg(PARENT_TS, 'Parent answer one'),
    taskComplete(PARENT_TS, 'Parent answer one'),
    tokenCount(PARENT_TS, { input: 12_345, output: 678 }),
  ]);

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  assert.match(blockContaining(readOut(s), 'Parent question one'), /Tokens=in 12,345, out 678/);
});

test('cx-inh 39: a shared call_id whose OUTPUT differs keeps the child pair', (t) => {
  const s = scaffold(t);
  // Ported from the _CX3 candidate's content-based comparison, kept as key
  // material rather than as a rendering step.
  //
  // Both copies run the very same call — same id, same name, same arguments —
  // but it returned something different. Identity by id alone declares the two
  // progress lists equal, so the child pair looks like a pure replay and gets
  // deleted, taking the only record of the second outcome with it. The
  // fingerprint appended to progressKey separates them, so the divergence is
  // seen and the child pair is kept (the safe side of requirement 5).
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Parent question one'),
    userItem(PARENT_TS, 'Parent question one', 'msg_p1'),
    toolCall(PARENT_TS, 'call-same'),
    toolResult(PARENT_TS, 'call-same', 'exit 0: build succeeded'),
    agentMsg(PARENT_TS, 'Parent answer one'),
    taskComplete(PARENT_TS, 'Parent answer one'),
  ]);
  writeChild(s, {
    history: [
      ...turn('turn-1', CHILD_TS, s.project),
      userMsg(CHILD_TS, 'Parent question one'),
      userItem(CHILD_TS, 'Parent question one', 'msg_p1'),
      toolCall(CHILD_TS, 'call-same'),
      toolResult(CHILD_TS, 'call-same', 'exit 1: build FAILED'),
      agentMsg(CHILD_TS, 'Parent answer one'),
      taskComplete(CHILD_TS, 'Parent answer one'),
    ],
    own: [],
  });

  const r = runCli([s.project, '-cx', '--verbose'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 2,
    'the differing tool output must not be deleted as a replay');
  assert.match(r.stdout, /kept 1 the original could not absorb/);
});

test('cx-inh 40: a byte-identical replay is still removed after the change', (t) => {
  const s = scaffold(t);
  // The counterpart of cx-inh 39: the fingerprint must not make ordinary
  // replays look divergent. Re-recording is byte-identical in practice, so the
  // fingerprints match and the child pair goes, exactly as before.
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Parent question one'),
    userItem(PARENT_TS, 'Parent question one', 'msg_p1'),
    toolCall(PARENT_TS, 'call-same'),
    toolResult(PARENT_TS, 'call-same', 'exit 0: build succeeded'),
    agentMsg(PARENT_TS, 'Parent answer one'),
    taskComplete(PARENT_TS, 'Parent answer one'),
  ]);
  writeChild(s, {
    history: [
      ...turn('turn-1', CHILD_TS, s.project),
      userMsg(CHILD_TS, 'Parent question one'),
      userItem(CHILD_TS, 'Parent question one', 'msg_p1'),
      toolCall(CHILD_TS, 'call-same'),
      toolResult(CHILD_TS, 'call-same', 'exit 0: build succeeded'),
      agentMsg(CHILD_TS, 'Parent answer one'),
      taskComplete(CHILD_TS, 'Parent answer one'),
    ],
    own: [],
  });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 1,
    'an identical replay must still be removed');
});

test('cx-inh 41: two subagents holding the SAME kept copy collapse to one', (t) => {
  const s = scaffold(t);
  // Everything above compares a child against its ANCESTORS. When several
  // children re-record the same turn and each ends on an answer the ancestor
  // does not have, each one differs from the ancestor in the very same way, so
  // every one of them is kept and the reader sees the identical question with
  // the identical answer once per child. Real logs showed one question repeated
  // four times this way, all four ending on the same sentence.
  //
  // Two children hold the same record when replay key, answer AND progress all
  // match; the surviving copy is itself the confirmation, so dropping the later
  // one loses nothing.
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Parent question one'),
    userItem(PARENT_TS, 'Parent question one', 'msg_p1'),
    agentMsg(PARENT_TS, 'The ancestor gave a different answer.'),
    taskComplete(PARENT_TS, 'The ancestor gave a different answer.'),
  ]);
  for (const [id, ts, nick, output] of [
    [CHILD_ID, CHILD_TS, 'one', 10],
    [CHILD2_ID, CHILD2_TS, 'two', 20],
  ]) {
    writeChild(s, {
      id, ts, nickname: nick,
      history: [
        tokenCount(ts, {}),
        ...turn('turn-1', ts, s.project),
        userMsg(ts, 'Parent question one'),
        userItem(ts, 'Parent question one', 'msg_p1'),
        agentMsg(ts, 'Finished: R1 through R7 are stacked.'),
        taskComplete(ts, 'Finished: R1 through R7 are stacked.'),
        tokenCount(ts, { output }),
      ],
      own: [],
    });
  }

  const r = runCli([s.project, '-cx', '--verbose'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const text = readOut(s);
  const hits = text.split('Finished: R1 through R7 are stacked.').length - 1;
  assert.equal(hits, 1, 'the identical kept copy must appear once, not once per child');
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 2,
    'the ancestor and one conflicting inherited copy must survive');
  assert.match(blockContaining(text, 'Finished: R1 through R7 are stacked.'), /Tokens=.*out 20/,
    'token fields from a removed sibling must be merged into the survivor');
  assert.match(r.stdout, /kept 1 the original could not absorb/,
    'the conflict count must describe surviving conflicts only');
  assert.equal(occurrences(r.stdout, 'kept (differing answer'), 1,
    'verbose diagnostics must not mention the removed sibling');
});

test('cx-inh 42: a subagent\'s OWN work is never dropped against a sibling', (t) => {
  const s = scaffold(t);
  // The counterpart of cx-inh 41. Two subagents were given the same task and
  // reported the same thing, but neither report is a copy of the other — they
  // are two agents' work. Nothing an ancestor confirmed is involved, so the
  // sibling pass must not touch them.
  writeParent(s);
  for (const [id, ts, nick] of [[CHILD_ID, CHILD_TS, 'one'], [CHILD2_ID, CHILD2_TS, 'two']]) {
    writeChild(s, {
      id, ts, nickname: nick,
      history: [],
      own: [
        marker(ts),
        instruction(ts, NEW_TASK, { turnId: 'own-turn' }),
        ...turn('own-turn', ts, s.project),
        agentMsg(ts, 'Audit complete: no findings.'),
        taskComplete(ts, 'Audit complete: no findings.'),
      ],
    });
  }

  const r = runCli([s.project, '-cx'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const hits = readOut(s).split('Audit complete: no findings.').length - 1;
  assert.equal(hits, 2, 'both agents did that work; neither report may be deleted');
});

test('cx-inh 43: sibling removal still requires the question text hash to match', (t) => {
  const s = scaffold(t);
  const GRANDCHILD_ID = '44444444-4444-4444-8444-444444444444';

  // The repeated message id deliberately collides across two different texts.
  // Each descendant is confirmed against a different ancestor in the same
  // lineage. The final text hash is therefore the only thing preventing the
  // sibling pass from deleting one differently-worded question.
  writeCodexSession(s.home, parentFileName(), [
    rootMeta(s.project),
    ...turn('turn-shared', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Question text A'),
    userItem(PARENT_TS, 'Question text A', 'msg_collision'),
    agentMsg(PARENT_TS, 'Root answer'),
    taskComplete(PARENT_TS, 'Root answer'),
  ]);
  writeChild(s, {
    id: CHILD_ID,
    history: [
      ...turn('turn-shared', CHILD_TS, s.project),
      userMsg(CHILD_TS, 'Question text B'),
      userItem(CHILD_TS, 'Question text B', 'msg_collision'),
      agentMsg(CHILD_TS, 'Intermediate answer'),
      taskComplete(CHILD_TS, 'Intermediate answer'),
    ],
    own: [],
  });
  for (const [id, ts, text] of [
    [CHILD2_ID, CHILD2_TS, 'Question text A'],
    [GRANDCHILD_ID, '2026-05-27T14:00:00.000Z', 'Question text B'],
  ]) {
    writeChild(s, {
      id, ts, parentThreadId: CHILD_ID,
      history: [
        ...turn('turn-shared', ts, s.project),
        userMsg(ts, text),
        userItem(ts, text, 'msg_collision'),
        agentMsg(ts, 'Shared descendant answer'),
        taskComplete(ts, 'Shared descendant answer'),
      ],
      own: [],
    });
  }

  const r = runCli([s.project, '-cx'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const text = readOut(s);
  assert.equal(occurrences(text, 'Shared descendant answer'), 2,
    'different question text must survive even when every other sibling key field matches');
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 4);
});
