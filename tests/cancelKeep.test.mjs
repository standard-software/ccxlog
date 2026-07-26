// v1.4.0 R1: Claude の「回答が一切ないままキャンセルされ打ち直された質問」
// （同じ parentUuid からの兄弟フォークによる置換）を、置換ではなく
// 「前の質問を回答なしの独立ペアとして確定」して保持するガードテスト。
// - A キャンセル→B 送信で A・B 両方が残る
// - A→B→C 連続キャンセルで 3 件残る
// - 追い打ちメッセージの同一ペア統合（additionalQuestionEntries）は現状維持
// - 回答（assistant）開始後の次質問によるペア確定は現状維持
// - 既存ペアの ccxlogid はキャンセルペアの追加で一切変わらない（R1-5）
// - aggregate / per-session 両モードで同じ挙動（R1-6）
// - キャンセルペア追加の再生成は「ID 追加のみ」なので自動バックアップを
//   作らない（R2 との結合、R4-4）
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

// 共通の土台: 通常の 1 問 1 答（u0/a0）のあとにキャンセル劇が起きる。
const lead = [U('u0', null, T('00'), 'Q0'), A('a0', 'u0', T('01'), 'A0')];

const questionOf = (p) => p.questionEntry.message.content;
const answerOf = (p) => (p.finalAssistantEntry
  ? (p.finalAssistantEntry.message.content.find?.(b => b.type === 'text')?.text ?? '')
  : '');

test('R1: A キャンセル→B 打ち直しで A・B 両方が独立ペアとして残る', () => {
  const pairs = buildPairs([
    ...lead,
    U('u1', 'a0', T('10'), 'A-cancelled'),   // 回答ゼロのままキャンセル
    U('u2', 'a0', T('20'), 'B-retyped'),     // 同じ親からの兄弟フォーク＝打ち直し
    A('a2', 'u2', T('21'), 'B-answer'),
  ]);
  assert.equal(pairs.length, 3);
  assert.deepEqual(pairs.map(questionOf), ['Q0', 'A-cancelled', 'B-retyped']);
  assert.equal(answerOf(pairs[1]), '', 'キャンセル質問は回答なしペアとして確定する');
  assert.equal(pairs[1].additionalQuestionEntries.length, 0);
  assert.equal(pairs[1].progressEntries.length, 0);
  assert.equal(answerOf(pairs[2]), 'B-answer');
});

test('R1-2: A→B→C 連続キャンセルで 3 つの質問すべてが残る', () => {
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

test('R1-3: 追い打ちメッセージ（別 parentUuid）の同一ペア統合は現状維持', () => {
  const pairs = buildPairs([
    ...lead,
    U('u1', 'a0', T('10'), 'first message'),
    // 兄弟フォークではなく u1 にぶら下がる追い打ち → 同一ペアに統合される。
    U('u2', 'u1', T('11'), 'follow-up while busy'),
    A('a2', 'u2', T('12'), 'combined answer'),
  ]);
  assert.equal(pairs.length, 2);
  assert.equal(questionOf(pairs[1]), 'first message');
  assert.deepEqual(pairs[1].additionalQuestionEntries.map(e => e.message.content), ['follow-up while busy']);
  assert.equal(answerOf(pairs[1]), 'combined answer');
});

test('R1-4: 回答（assistant）開始後の次質問によるペア確定は現状維持', () => {
  const pairs = buildPairs([
    ...lead,
    U('u1', 'a0', T('10'), 'answered question'),
    A('a1', 'u1', T('11'), 'its answer'),
    // 回答開始後に同じ親からの兄弟が来ても、前ペアは回答つきで確定済み。
    U('u2', 'a0', T('20'), 'next question'),
    A('a2', 'u2', T('21'), 'next answer'),
  ]);
  assert.equal(pairs.length, 3);
  assert.equal(questionOf(pairs[1]), 'answered question');
  assert.equal(answerOf(pairs[1]), 'its answer');
  assert.equal(questionOf(pairs[2]), 'next question');
  assert.equal(answerOf(pairs[2]), 'next answer');
});

test('R1-5: キャンセルペアの追加は既存ペアの ccxlogid を一切変えない', () => {
  const unify = (pairs) => pairs.map((pair, i) => toUnifiedPair({
    pair, source: 'claude', sourceLabel: 'ClaudeCode', sessionId: 'sess',
    sessionName: '', sourceFile: '/x.jsonl',
    sourceFileRelativeId: 'claude/standard/std/x.jsonl',
    fileContentHash: async () => '', eventIdStream: [], questionOrdinal: i,
  }));
  // キャンセルエントリを含まないログ（v1.3.0 までの出力に相当する 2 ペア）。
  const withoutCancel = unify(buildPairs([
    ...lead,
    U('u2', 'a0', T('20'), 'B-retyped'),
    A('a2', 'u2', T('21'), 'B-answer'),
  ]));
  // 同じログにキャンセルエントリが挟まった場合（3 ペア）。
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
  // 既存 2 ペア（Q0 / B-retyped）の id は questionOrdinal がずれても不変。
  assert.equal(withCancel[0].ccxid, withoutCancel[0].ccxid);
  assert.equal(withCancel[2].ccxid, withoutCancel[1].ccxid);
});

// ---- CLI 統合（R1-6: aggregate / per-session 両モード、R4-4: 移行時の
// 再生成が「ID 追加のみ」で自動バックアップを作らないこと） ----------------

const cancelSession = (withCancel) => [
  U('u0', null, T('00'), 'Q-zero'),
  A('a0', 'u0', T('01'), 'A-zero'),
  ...(withCancel ? [U('u1', 'a0', T('10'), 'CANCELLED-question')] : []),
  U('u2', 'a0', T('20'), 'RETYPED-question'),
  A('a2', 'u2', T('21'), 'RETYPED-answer'),
];

const idsOf = (text) => (text.match(/<!-- ccxlogid:[0-9a-f]{24} -->/g) ?? []);

test('R1-6/R4-4: aggregate — キャンセル質問が出力され、移行の再生成はバックアップなしの rewrite', t => {
  const ws = workspace(t);
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });
  const log = path.join(ws.ccLogs, 'sess.jsonl');
  const file = path.join(ws.out, 'cclog.md');

  // v1.3.0 相当の初回出力: キャンセルエントリはログにあるが旧ロジックでは
  // 消えていた……を再現するため、まずキャンセル行なしのログで生成する。
  writeJsonl(log, cancelSession(false));
  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);
  const before = read(file);
  assert.doesNotMatch(before, /CANCELLED-question/);

  // 同じセッションにキャンセルエントリが現れた状態で再生成（＝v1.4.0 移行）。
  writeJsonl(log, cancelSession(true));
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const after = read(file);
  assert.match(after, /CANCELLED-question/);
  assert.match(after, /RETYPED-question/);
  // 旧 ccxlogid 集合 ⊆ 新 ccxlogid 集合（ID は追加のみ）。
  const beforeIds = new Set(idsOf(before));
  for (const id of beforeIds) assert.ok(after.includes(id), `既存 id が失われた: ${id}`);
  assert.equal(idsOf(after).length, beforeIds.size + 1);
  // ID 追加のみの書き換えなので自動バックアップは作られない（R2/R4-4）。
  assert.match(r.stdout, /\[rewrite\]/);
  assert.doesNotMatch(r.stdout, /Backed up/);
  assert.equal(exists(path.join(ws.out, 'backup_CCXLOG_md')), false);
});

test('R1-6/R4-4: per-session — キャンセル質問が出力され、移行の再生成はバックアップなしの rewrite', t => {
  const ws = workspace(t);
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });
  const log = path.join(ws.ccLogs, 'sess.jsonl');

  // aggregate 版と同じ移行シナリオ: まずキャンセル行なしのログで初回生成
  // （v1.3.0 相当の per-session 出力）。
  writeJsonl(log, cancelSession(false));
  assert.equal(run([ws.project, '--out', ws.out, '-cc', '--per-session'], { home: ws.home }).status, 0);
  const files = fs.readdirSync(ws.out).filter(n => n.startsWith('cclog_') && n.endsWith('.md'));
  assert.equal(files.length, 1);
  const file = path.join(ws.out, files[0]);
  const before = read(file);
  assert.doesNotMatch(before, /CANCELLED-question/);

  // 同じセッションにキャンセルエントリが現れた状態で再生成（＝v1.4.0 移行）。
  writeJsonl(log, cancelSession(true));
  const r = run([ws.project, '--out', ws.out, '-cc', '--per-session'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const filesAfter = fs.readdirSync(ws.out).filter(n => n.startsWith('cclog_') && n.endsWith('.md'));
  assert.deepEqual(filesAfter, files, '再生成でファイル名は変わらない');
  const after = read(file);
  assert.match(after, /CANCELLED-question/);
  assert.match(after, /RETYPED-question/);
  // 旧 ccxlogid 集合 ⊆ 新 ccxlogid 集合（ID は追加のみ）。
  const beforeIds = new Set(idsOf(before));
  for (const id of beforeIds) assert.ok(after.includes(id), `既存 id が失われた: ${id}`);
  assert.equal(idsOf(after).length, beforeIds.size + 1);
  // ID 追加のみの書き換えなので自動バックアップは作られない（R2/R4-4）。
  assert.match(r.stdout, /\[rewrite\]/);
  assert.doesNotMatch(r.stdout, /Backed up/);
  assert.equal(exists(path.join(ws.out, 'backup_CCXLOG_md')), false);
});
