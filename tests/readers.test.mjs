import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl as readCodex } from '../dist/sources/codex/jsonlReader.js';
import { buildPairs as buildCodexPairs } from '../dist/sources/codex/pairBuilder.js';
import { readJsonl as readClaude } from '../dist/sources/claude/jsonlReader.js';
import { buildPairs as buildClaudePairs } from '../dist/sources/claude/pairBuilder.js';
import { extractTokenTotals } from '../dist/lib/metaExtractor.js';
import { mkTmp, rmrf, writeJsonl } from './helpers.mjs';

function codexFixture(records) {
  const dir = mkTmp('ccx-codex-');
  const file = path.join(dir, 'rollout.jsonl');
  writeJsonl(file, records);
  return { dir, file };
}
const answerOf = (pair) => (pair.finalAssistantEntry
  ? (pair.finalAssistantEntry.message.content.find?.(b => b.type === 'text')?.text ?? '')
  : '');

test('codex: an interrupted turn (only reasoning/tool) has no answer and does not swallow the next question', async () => {
  const { dir, file } = codexFixture([
    { type: 'session_meta', timestamp: '2026-05-27T11:00:00Z', payload: { session_id: 's', cwd: '/p', cli_version: '1' } },
    { type: 'turn_context', timestamp: '2026-05-27T11:00:00Z', payload: { turn_id: 't1', cwd: '/p', model: 'gpt-5' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:01Z', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:02Z', payload: { type: 'user_message', message: 'Q1' } },
    { type: 'response_item', timestamp: '2026-05-27T11:00:03Z', payload: { type: 'reasoning', summary: [{ text: 'thinking...' }] } },
    { type: 'response_item', timestamp: '2026-05-27T11:00:04Z', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: '{}' } },
    // turn interrupted here: no agent_message, no task_complete
    { type: 'event_msg', timestamp: '2026-05-27T11:00:05Z', payload: { type: 'task_started', turn_id: 't2' } },
    { type: 'turn_context', timestamp: '2026-05-27T11:00:05Z', payload: { turn_id: 't2', cwd: '/p', model: 'gpt-5' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:06Z', payload: { type: 'user_message', message: 'Q2' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:07Z', payload: { type: 'agent_message', message: 'A2' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:08Z', payload: { type: 'task_complete', last_agent_message: 'A2' } },
  ]);
  try {
    const { entries } = await readCodex(file);
    const pairs = buildCodexPairs(entries);
    assert.equal(pairs.length, 2, 'both questions must survive as separate pairs');
    assert.equal(pairs[0].questionEntry.message.content, 'Q1');
    assert.equal(answerOf(pairs[0]), '', 'reasoning/tool must not become the answer');
    assert.ok(pairs[0].progressEntries.length >= 2, 'reasoning + tool are progress');
    assert.equal(pairs[1].questionEntry.message.content, 'Q2');
    assert.equal(answerOf(pairs[1]), 'A2');
  } finally { rmrf(dir); }
});

test('codex: a response_item question is recovered even without task_complete', async () => {
  const { dir, file } = codexFixture([
    { type: 'session_meta', timestamp: '2026-05-27T11:00:00Z', payload: { session_id: 's', cwd: '/p', cli_version: '1' } },
    { type: 'turn_context', timestamp: '2026-05-27T11:00:00Z', payload: { turn_id: 't1', cwd: '/p', model: 'gpt-5' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:01Z', payload: { type: 'task_started', turn_id: 't1' } },
    // no user_message event; the user text only exists as a response_item
    { type: 'response_item', timestamp: '2026-05-27T11:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Recovered Q' }] } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:03Z', payload: { type: 'agent_message', message: 'Recovered A' } },
    // no task_complete
  ]);
  try {
    const { entries } = await readCodex(file);
    const pairs = buildCodexPairs(entries);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].questionEntry.message.content, 'Recovered Q');
    assert.equal(answerOf(pairs[0]), 'Recovered A');
  } finally { rmrf(dir); }
});

test('codex: injected-context response_item is NOT recovered as a question', async () => {
  const { dir, file } = codexFixture([
    { type: 'session_meta', timestamp: '2026-05-27T11:00:00Z', payload: { session_id: 's', cwd: '/p', cli_version: '1' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:01Z', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'response_item', timestamp: '2026-05-27T11:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>secret</environment_context>' }] } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:03Z', payload: { type: 'agent_message', message: 'Hi' } },
  ]);
  try {
    const { entries } = await readCodex(file);
    const pairs = buildCodexPairs(entries);
    // No real question was ever typed, so the noise must not become one.
    assert.ok(pairs.every(p => !p.questionEntry.message.content.includes('environment_context')));
  } finally { rmrf(dir); }
});

test('codex: the FIRST token_count credits the cumulative total, not last_token_usage', async () => {
  const { dir, file } = codexFixture([
    { type: 'session_meta', timestamp: '2026-05-27T11:00:00Z', payload: { session_id: 's', cwd: '/p', cli_version: '1' } },
    { type: 'turn_context', timestamp: '2026-05-27T11:00:00Z', payload: { turn_id: 't1', cwd: '/p', model: 'gpt-5' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:01Z', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:02Z', payload: { type: 'user_message', message: 'Q' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:03Z', payload: { type: 'agent_message', message: 'A' } },
    // Several API calls already happened before this first notification: the
    // cumulative total (100/50) is the real usage; last_token_usage (10/5) is
    // only the most recent call and would undercount.
    { type: 'event_msg', timestamp: '2026-05-27T11:00:04Z', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 7 },
      last_token_usage: { input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 1 },
    } } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:05Z', payload: { type: 'task_complete', last_agent_message: 'A' } },
  ]);
  try {
    const { entries } = await readCodex(file);
    const pairs = buildCodexPairs(entries);
    const t = extractTokenTotals(pairs[0], 'codex');
    assert.equal(t.input, 100);
    assert.equal(t.output, 50);
    assert.equal(t.reasoning, 7);
  } finally { rmrf(dir); }
});

test('codex: multiple response_item fallback questions in one turn are ALL kept', async () => {
  const { dir, file } = codexFixture([
    { type: 'session_meta', timestamp: '2026-05-27T11:00:00Z', payload: { session_id: 's', cwd: '/p', cli_version: '1' } },
    { type: 'turn_context', timestamp: '2026-05-27T11:00:00Z', payload: { turn_id: 't1', cwd: '/p', model: 'gpt-5' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:01Z', payload: { type: 'task_started', turn_id: 't1' } },
    // No user_message event; TWO real user messages exist only as response_items.
    { type: 'response_item', timestamp: '2026-05-27T11:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'FB1' }] } },
    { type: 'response_item', timestamp: '2026-05-27T11:00:03Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'FB2' }] } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:04Z', payload: { type: 'agent_message', message: 'A' } },
  ]);
  try {
    const { entries } = await readCodex(file);
    const pairs = buildCodexPairs(entries);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].questionEntry.message.content, 'FB1', 'first fallback is the question');
    assert.deepEqual(pairs[0].additionalQuestionEntries.map(e => e.message.content), ['FB2'], 'second fallback is kept too');
    assert.equal(answerOf(pairs[0]), 'A');
  } finally { rmrf(dir); }
});

test('codex: two same-timestamp same-content fallbacks WITHOUT a stable id are BOTH kept', async () => {
  // Guard against silent data loss: real Codex user response_items carry no
  // per-item id, so a resend and a genuine repeat (same text typed twice in the
  // same millisecond) are indistinguishable. When no verified id is present the
  // reader must NOT prune on (timestamp, content) — both must survive (§6.2
  // "確定できなければ残す").
  const { dir, file } = codexFixture([
    { type: 'session_meta', timestamp: '2026-05-27T11:00:00Z', payload: { session_id: 's', cwd: '/p', cli_version: '1' } },
    { type: 'turn_context', timestamp: '2026-05-27T11:00:00Z', payload: { turn_id: 't1', cwd: '/p', model: 'gpt-5' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:01Z', payload: { type: 'task_started', turn_id: 't1' } },
    // Identical content AND identical timestamp, NO id (the real schema shape).
    { type: 'response_item', timestamp: '2026-05-27T11:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'FB' }] } },
    { type: 'response_item', timestamp: '2026-05-27T11:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'FB' }] } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:03Z', payload: { type: 'agent_message', message: 'A' } },
  ]);
  try {
    const { entries } = await readCodex(file);
    const pairs = buildCodexPairs(entries);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].questionEntry.message.content, 'FB', 'first fallback is the question');
    assert.deepEqual(pairs[0].additionalQuestionEntries.map(e => e.message.content), ['FB'], 'without a stable id, an ambiguous repeat must be preserved, not pruned');
  } finally { rmrf(dir); }
});

test('codex: a replay proven by a repeated stable per-item message id IS dropped once', async () => {
  // When (and only when) a verified per-item message id (`msg_…` payload.id)
  // repeats, the record is a true replay and the duplicate is dropped.
  const { dir, file } = codexFixture([
    { type: 'session_meta', timestamp: '2026-05-27T11:00:00Z', payload: { session_id: 's', cwd: '/p', cli_version: '1' } },
    { type: 'turn_context', timestamp: '2026-05-27T11:00:00Z', payload: { turn_id: 't1', cwd: '/p', model: 'gpt-5' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:01Z', payload: { type: 'task_started', turn_id: 't1' } },
    // Same item id `msg_x` serialized twice = one record replayed.
    { type: 'response_item', timestamp: '2026-05-27T11:00:02Z', payload: { type: 'message', role: 'user', id: 'msg_x', content: [{ type: 'input_text', text: 'FB' }] } },
    { type: 'response_item', timestamp: '2026-05-27T11:00:03Z', payload: { type: 'message', role: 'user', id: 'msg_x', content: [{ type: 'input_text', text: 'FB' }] } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:04Z', payload: { type: 'agent_message', message: 'A' } },
  ]);
  try {
    const { entries } = await readCodex(file);
    const pairs = buildCodexPairs(entries);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].questionEntry.message.content, 'FB');
    assert.deepEqual(pairs[0].additionalQuestionEntries.map(e => e.message.content), [], 'a repeated verified item id is a replay and must not double the question');
  } finally { rmrf(dir); }
});

test('codex: distinct stable per-item message ids keep BOTH messages even with same text', async () => {
  // Two different verified item ids = two distinct records, even if the text is
  // identical: both must survive.
  const { dir, file } = codexFixture([
    { type: 'session_meta', timestamp: '2026-05-27T11:00:00Z', payload: { session_id: 's', cwd: '/p', cli_version: '1' } },
    { type: 'turn_context', timestamp: '2026-05-27T11:00:00Z', payload: { turn_id: 't1', cwd: '/p', model: 'gpt-5' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:01Z', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'response_item', timestamp: '2026-05-27T11:00:02Z', payload: { type: 'message', role: 'user', id: 'msg_a', content: [{ type: 'input_text', text: 'FB' }] } },
    { type: 'response_item', timestamp: '2026-05-27T11:00:02Z', payload: { type: 'message', role: 'user', id: 'msg_b', content: [{ type: 'input_text', text: 'FB' }] } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:03Z', payload: { type: 'agent_message', message: 'A' } },
  ]);
  try {
    const { entries } = await readCodex(file);
    const pairs = buildCodexPairs(entries);
    assert.equal(pairs.length, 1);
    assert.deepEqual(pairs[0].additionalQuestionEntries.map(e => e.message.content), ['FB'], 'distinct item ids are distinct records — both kept');
  } finally { rmrf(dir); }
});

test('codex: an INTENTIONAL repeat (same content, different timestamp) of a fallback question is kept', async () => {
  const { dir, file } = codexFixture([
    { type: 'session_meta', timestamp: '2026-05-27T11:00:00Z', payload: { session_id: 's', cwd: '/p', cli_version: '1' } },
    { type: 'turn_context', timestamp: '2026-05-27T11:00:00Z', payload: { turn_id: 't1', cwd: '/p', model: 'gpt-5' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:01Z', payload: { type: 'task_started', turn_id: 't1' } },
    // The user genuinely sent the same text twice, at different times.
    { type: 'response_item', timestamp: '2026-05-27T11:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'FB' }] } },
    { type: 'response_item', timestamp: '2026-05-27T11:00:03Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'FB' }] } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:04Z', payload: { type: 'agent_message', message: 'A' } },
  ]);
  try {
    const { entries } = await readCodex(file);
    const pairs = buildCodexPairs(entries);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].questionEntry.message.content, 'FB');
    assert.deepEqual(pairs[0].additionalQuestionEntries.map(e => e.message.content), ['FB'], 'a distinct-timestamp repeat must be preserved');
  } finally { rmrf(dir); }
});

test('codex: a trailing response_item fallback at EOF is not lost', async () => {
  const { dir, file } = codexFixture([
    { type: 'session_meta', timestamp: '2026-05-27T11:00:00Z', payload: { session_id: 's', cwd: '/p', cli_version: '1' } },
    { type: 'turn_context', timestamp: '2026-05-27T11:00:00Z', payload: { turn_id: 't1', cwd: '/p', model: 'gpt-5' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:01Z', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:02Z', payload: { type: 'user_message', message: 'Q1' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:03Z', payload: { type: 'agent_message', message: 'A1' } },
    { type: 'event_msg', timestamp: '2026-05-27T11:00:04Z', payload: { type: 'task_complete', last_agent_message: 'A1' } },
    // A new turn whose only user input is a response_item, then EOF (interrupted
    // before any agent_message / task_complete). The question must survive.
    { type: 'event_msg', timestamp: '2026-05-27T11:00:05Z', payload: { type: 'task_started', turn_id: 't2' } },
    { type: 'turn_context', timestamp: '2026-05-27T11:00:05Z', payload: { turn_id: 't2', cwd: '/p', model: 'gpt-5' } },
    { type: 'response_item', timestamp: '2026-05-27T11:00:06Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Trailing Q' }] } },
  ]);
  try {
    const { entries } = await readCodex(file);
    const pairs = buildCodexPairs(entries);
    assert.equal(pairs.length, 2, 'the EOF fallback question forms its own pair');
    assert.equal(pairs[1].questionEntry.message.content, 'Trailing Q');
    assert.equal(answerOf(pairs[1]), '');
  } finally { rmrf(dir); }
});

test('CX#9: a fallback question keeps its own timestamp, not task_complete time', async () => {
  // The question exists only as a response_item at 10:00:03; task_complete lands
  // five minutes later. The question's timestamp must be the response_item time
  // (so ordering/ccxid grouping stay correct), not the far-later completion time.
  const { dir, file } = codexFixture([
    { type: 'session_meta', timestamp: '2026-05-27T10:00:00.000Z', payload: { session_id: 's', cwd: '/p' } },
    { type: 'turn_context', timestamp: '2026-05-27T10:00:01.000Z', payload: { turn_id: 't1', cwd: '/p', model: 'm' } },
    { type: 'event_msg', timestamp: '2026-05-27T10:00:02.000Z', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'response_item', timestamp: '2026-05-27T10:00:03.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
    { type: 'event_msg', timestamp: '2026-05-27T10:00:04.000Z', payload: { type: 'agent_message', message: 'hello' } },
    { type: 'event_msg', timestamp: '2026-05-27T10:05:00.000Z', payload: { type: 'task_complete', last_agent_message: 'hello' } },
  ]);
  try {
    const { entries } = await readCodex(file);
    const pairs = buildCodexPairs(entries);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].questionEntry.timestamp, '2026-05-27T10:00:03.000Z',
      'question time must be the response_item time, not the task_complete time');
  } finally { rmrf(dir); }
});

test('claude: sidechain pairs are excluded by default, malformed lines skipped', async () => {
  const dir = mkTmp('ccx-claude-');
  const file = path.join(dir, 'sess.jsonl');
  try {
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-05-27T11:00:00Z', message: { role: 'user', content: 'Main Q' } }),
      '{ broken json line',
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-05-27T11:00:01Z', message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'Main A' }] } }),
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: null, isSidechain: true, timestamp: '2026-05-27T11:00:02Z', message: { role: 'user', content: 'Sidechain Q' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', isSidechain: true, timestamp: '2026-05-27T11:00:03Z', message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'Sidechain A' }] } }),
    ].join('\n') + '\n', 'utf-8');
    const { entries, skippedLines } = await readClaude(file);
    assert.equal(skippedLines, 1);
    const pairs = buildClaudePairs(entries, { includeSidechain: false });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].questionEntry.message.content, 'Main Q');
  } finally { rmrf(dir); }
});
