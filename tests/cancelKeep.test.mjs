import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildPairs } from '../dist/sources/claude/pairBuilder.js';
import { toUnifiedPair } from '../dist/lib/markdownWriter.js';
import { assignCcxids } from '../dist/lib/identity.js';
import {
  run, workspace, writeConfig, writeJsonl, read, exists,
} from './helpers.mjs';

const U = (uuid, parentUuid, ts, text) => ({
  type: 'user', uuid, parentUuid, timestamp: ts,
  message: { role: 'user', content: text },
});
const A = (uuid, parentUuid, ts, text) => ({
  type: 'assistant', uuid, parentUuid, timestamp: ts,
  message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text }] },
});

const T = (s) => `2026-05-27T11:00:${s}.000Z`;

const lead = [U('u0', null, T('00'), 'Q0'), A('a0', 'u0', T('01'), 'A0')];

const questionOf = (p) => p.questionEntry.message.content;
const answerOf = (p) => (p.finalAssistantEntry
  ? (p.finalAssistantEntry.message.content.find?.(b => b.type === 'text')?.text ?? '')
  : '');

test('R1: cancelling A and retrying as B preserves both as independent pairs', () => {
  const pairs = buildPairs([
    ...lead,
    U('u1', 'a0', T('10'), 'A-cancelled'),
    U('u2', 'a0', T('20'), 'B-retyped'),
    A('a2', 'u2', T('21'), 'B-answer'),
  ]);
  assert.equal(pairs.length, 3);
  assert.deepEqual(pairs.map(questionOf), ['Q0', 'A-cancelled', 'B-retyped']);
  assert.equal(answerOf(pairs[1]), '', 'the cancelled question is finalized as a pair without an answer');
  assert.equal(pairs[1].additionalQuestionEntries.length, 0);
  assert.equal(pairs[1].progressEntries.length, 0);
  assert.equal(answerOf(pairs[2]), 'B-answer');
});

test('R1-2: cancelling A, B, and C in sequence preserves all three questions', () => {
  const pairs = buildPairs([
    ...lead,
    U('u1', 'a0', T('10'), 'A-cancelled'),
    U('u2', 'a0', T('20'), 'B-cancelled'),
    U('u3', 'a0', T('30'), 'C-final'),
    A('a3', 'u3', T('31'), 'C-answer'),
  ]);
  assert.equal(pairs.length, 4);
  assert.deepEqual(pairs.map(questionOf), ['Q0', 'A-cancelled', 'B-cancelled', 'C-final']);
  assert.equal(answerOf(pairs[1]), '');
  assert.equal(answerOf(pairs[2]), '');
  assert.equal(answerOf(pairs[3]), 'C-answer');
});

test('R1-3: follow-up messages with different parentUuid values still merge into one pair', () => {
  const pairs = buildPairs([
    ...lead,
    U('u1', 'a0', T('10'), 'first message'),
    U('u2', 'u1', T('11'), 'follow-up while busy'),
    A('a2', 'u2', T('12'), 'combined answer'),
  ]);
  assert.equal(pairs.length, 2);
  assert.equal(questionOf(pairs[1]), 'first message');
  assert.deepEqual(pairs[1].additionalQuestionEntries.map(e => e.message.content), ['follow-up while busy']);
  assert.equal(answerOf(pairs[1]), 'combined answer');
});

test('R1-4: a new question after an assistant response still finalizes the previous pair', () => {
  const pairs = buildPairs([
    ...lead,
    U('u1', 'a0', T('10'), 'answered question'),
    A('a1', 'u1', T('11'), 'its answer'),
    U('u2', 'a0', T('20'), 'next question'),
    A('a2', 'u2', T('21'), 'next answer'),
  ]);
  assert.equal(pairs.length, 3);
  assert.equal(questionOf(pairs[1]), 'answered question');
  assert.equal(answerOf(pairs[1]), 'its answer');
  assert.equal(questionOf(pairs[2]), 'next question');
  assert.equal(answerOf(pairs[2]), 'next answer');
});

test('R1-5: adding a cancelled pair does not change existing ccxlogid values', () => {
  const unify = (pairs) => pairs.map((pair, i) => toUnifiedPair({
    pair, source: 'claude', sourceLabel: 'ClaudeCode', sessionId: 'sess',
    sessionName: '', sourceFile: '/x.jsonl',
    sourceFileRelativeId: 'claude/standard/std/x.jsonl',
    fileContentHash: async () => '', eventIdStream: [], questionOrdinal: i,
  }));
  const withoutCancel = unify(buildPairs([
    ...lead,
    U('u2', 'a0', T('20'), 'B-retyped'),
    A('a2', 'u2', T('21'), 'B-answer'),
  ]));
  const withCancel = unify(buildPairs([
    ...lead,
    U('u1', 'a0', T('10'), 'A-cancelled'),
    U('u2', 'a0', T('20'), 'B-retyped'),
    A('a2', 'u2', T('21'), 'B-answer'),
  ]));
  assignCcxids(withoutCancel);
  assignCcxids(withCancel);
  assert.equal(withoutCancel.length, 2);
  assert.equal(withCancel.length, 3);
  assert.equal(withCancel[0].ccxid, withoutCancel[0].ccxid);
  assert.equal(withCancel[2].ccxid, withoutCancel[1].ccxid);
});


const cancelSession = (withCancel) => [
  U('u0', null, T('00'), 'Q-zero'),
  A('a0', 'u0', T('01'), 'A-zero'),
  ...(withCancel ? [U('u1', 'a0', T('10'), 'CANCELLED-question')] : []),
  U('u2', 'a0', T('20'), 'RETYPED-question'),
  A('a2', 'u2', T('21'), 'RETYPED-answer'),
];

const idsOf = (text) => (text.match(/<!-- ccxlogid:[0-9a-f]{24} -->/g) ?? []);

test('R1-6/R4-4: aggregate includes cancelled questions and migration rewrites without a backup', t => {
  const ws = workspace(t);
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });
  const log = path.join(ws.ccLogs, 'sess.jsonl');
  const file = path.join(ws.out, 'cclog.md');

  writeJsonl(log, cancelSession(false));
  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);
  const before = read(file);
  assert.doesNotMatch(before, /CANCELLED-question/);

  writeJsonl(log, cancelSession(true));
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const after = read(file);
  assert.match(after, /CANCELLED-question/);
  assert.match(after, /RETYPED-question/);
  const beforeIds = new Set(idsOf(before));
  for (const id of beforeIds) assert.ok(after.includes(id), `existing ID was lost: ${id}`);
  assert.equal(idsOf(after).length, beforeIds.size + 1);
  assert.match(r.stdout, /\[rewrite\]/);
  assert.doesNotMatch(r.stdout, /Backed up/);
  assert.equal(exists(path.join(ws.out, 'backup_CCXLOG_md_auto')), false);
});

test('R1-6/R4-4: per-session includes cancelled questions and migration rewrites without a backup', t => {
  const ws = workspace(t);
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });
  const log = path.join(ws.ccLogs, 'sess.jsonl');

  writeJsonl(log, cancelSession(false));
  assert.equal(run([ws.project, '--out', ws.out, '-cc', '--per-session'], { home: ws.home }).status, 0);
  const files = fs.readdirSync(ws.out).filter(n => n.startsWith('cclog_') && n.endsWith('.md'));
  assert.equal(files.length, 1);
  const file = path.join(ws.out, files[0]);
  const before = read(file);
  assert.doesNotMatch(before, /CANCELLED-question/);

  writeJsonl(log, cancelSession(true));
  const r = run([ws.project, '--out', ws.out, '-cc', '--per-session'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const filesAfter = fs.readdirSync(ws.out).filter(n => n.startsWith('cclog_') && n.endsWith('.md'));
  assert.deepEqual(filesAfter, files, 'regeneration does not change file names');
  const after = read(file);
  assert.match(after, /CANCELLED-question/);
  assert.match(after, /RETYPED-question/);
  const beforeIds = new Set(idsOf(before));
  for (const id of beforeIds) assert.ok(after.includes(id), `existing ID was lost: ${id}`);
  assert.equal(idsOf(after).length, beforeIds.size + 1);
  assert.match(r.stdout, /\[rewrite\]/);
  assert.doesNotMatch(r.stdout, /Backed up/);
  assert.equal(exists(path.join(ws.out, 'backup_CCXLOG_md_auto')), false);
});
