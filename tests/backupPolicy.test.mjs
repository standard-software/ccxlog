// v1.4.0 R2: 自動バックアップは「書き換え前に存在した ccxlogid が書き換え後の
// 内容から1つでも失われる場合」のみ発火する（旧 amendWrite.test.mjs の後継。
// isSafeAmendment / 'amend' outcome は本判定への置換で削除された）。
// 判定不能（旧に有効 ID なし・不正形式・重複・新側の解析失敗）は安全側＝
// バックアップする。ID が保たれる限り、本文差し替え・途中挿入・並び順変更・
// テンプレート変更・末尾追記はバックアップしない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planWrite, commitPlan } from '../dist/lib/markdownWriter.js';
import { isDestructive, chooseMethod } from '../dist/lib/identity.js';
import { mkTmp, rmrf } from './helpers.mjs';

const OWNER = '<!-- ccxlog-owner:ccxlog; kind:aggregate; mode:both -->';
function agg(blocks) {
  return [OWNER, '<!-- notice -->', '# ccxlog', '', '- Project: x', '- Source: Codex', '', '', blocks].join('\n');
}
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccc';
const block = (id, body = 'content') => `<!-- ccxlogid:${id} -->\n# 2026/05/27 Wed 11:03:49\n${body}\n\n`;

// 実際のライブセッション相当: 前回実行時は回答途中で Model / Tokens / Answer
// が空のまま描画され、次回実行で同じブロックが埋まり新ブロックが追記される。
const unfinished = (id) => [
  `<!-- ccxlogid:${id} -->`,
  '# 2026/07/24 Fri 17:43:08   [ClaudeCode] Session:Claude1:7a7f3581',
  'Model= Version=2.1.170',
  'Tokens=',
  '## Question',
  '1でいきましょう。',
  '',
  '<!--',
  '## Answer',
  '',
  '-->',
  '',
].join('\n');
const finished = (id) => [
  `<!-- ccxlogid:${id} -->`,
  '# 2026/07/24 Fri 17:43:08   [ClaudeCode] Session:Claude1:7a7f3581',
  'Model=claude-opus-4-8 Version=2.1.170',
  'Tokens=in 135, out 1,907, cache read 2,039,101, cache write 880',
  '## Question',
  '1でいきましょう。',
  '',
  '<!--',
  '## Answer',
  '監視をバックグラウンドで起動しました。',
  '',
  '-->',
  '',
].join('\n');

async function planFor(existing, next) {
  const dir = mkTmp('ccx-bkp-');
  const file = path.join(dir, 'ccxlog.md');
  try {
    fs.writeFileSync(file, existing, 'utf-8');
    const res = await planWrite(file, next, 'aggregate');
    assert.equal(res.ok, true, res.ok ? '' : res.error);
    return res.plan;
  } finally { rmrf(dir); }
}

test('R2: 本文差し替え（ID 同一）は rewrite だがバックアップ不要', async () => {
  const plan = await planFor(agg(block(A, 'content')), agg(block(A, 'REWORDED body')));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, false);
});

test('R2: 時系列途中への新規ペア挿入はバックアップ不要', async () => {
  const plan = await planFor(agg(block(A) + block(B)), agg(block(A) + block(C) + block(B)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, false);
});

test('R2: 並び順変更はバックアップ不要', async () => {
  const plan = await planFor(agg(block(A) + block(B)), agg(block(B) + block(A)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, false);
});

test('R2: 未完ペアの穴埋め＋末尾追記（旧 amend 相当）はバックアップ不要', async () => {
  const dir = mkTmp('ccx-bkp-');
  const file = path.join(dir, 'ccxlog.md');
  try {
    fs.writeFileSync(file, agg(block(A) + unfinished(B)), 'utf-8');
    const after = agg(block(A) + finished(B) + block(C));
    const plan = (await planWrite(file, after, 'aggregate')).plan;
    assert.equal(plan.outcome, 'rewrite');
    assert.equal(plan.backupRequired, false);
    assert.equal((await commitPlan(plan, { dryRun: false, alreadyBackedUp: false })).result, 'rewrite');
    assert.equal(fs.readFileSync(file, 'utf-8'), after); // 全内容が正しく再現される
  } finally { rmrf(dir); }
});

test('R2: ID が 1 つでも失われる書き換えはバックアップ必須', async () => {
  const plan = await planFor(agg(block(A) + block(B)), agg(block(A) + block(C)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, true);
});

test('R2-2: 旧内容に有効な ccxlogid が無い場合は判定不能＝バックアップ', async () => {
  const plan = await planFor(agg('id のない本文\n'), agg(block(A)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, true);
});

test('R2-2: 旧内容に不正形式の ccxlogid 行があれば判定不能＝バックアップ', async () => {
  const plan = await planFor(agg('<!-- ccxlogid:not-a-real-id -->\nbody\n' + block(A)), agg(block(A) + block(B)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, true);
});

test('R2-2: 旧内容に同一 ID の重複があれば判定不能＝バックアップ', async () => {
  const plan = await planFor(agg(block(A) + block(A)), agg(block(A) + block(B)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, true);
});

test('R2-2: 新内容側の ID 解析失敗も判定不能＝バックアップ', async () => {
  const plan = await planFor(agg(block(A)), agg('<!-- ccxlogid:broken -->\nbody\n' + block(B)));
  assert.equal(plan.outcome, 'rewrite');
  assert.equal(plan.backupRequired, true);
});

test('isDestructive: method none は常に true（安全側）', () => {
  const oldBody = agg(block(A));
  assert.equal(chooseMethod(oldBody, 'no ids at all').method, 'none');
  assert.equal(isDestructive(oldBody, 'no ids at all', 'none'), true);
});

// ---- per-session（kind 'session'）でも同じ判定（R4-2 両モード） -----------

test('R4-2: per-session（kind session）でも ID 消失時だけバックアップする', async () => {
  const dir = mkTmp('ccx-bkp-session-');
  const file = path.join(dir, 'session.md');
  const owner = '<!-- ccxlog-owner:ccxlog; kind:session; source:claude; sid64:cw -->';
  const session = (blocks) => [owner, '<!-- notice -->', blocks].join('\n');
  try {
    fs.writeFileSync(file, session(block(A) + block(B)), 'utf-8');
    // 並び順変更（ID 全保持）→ rewrite だがバックアップ不要。
    const kept = (await planWrite(file, session(block(B) + block(A)), 'session')).plan;
    assert.equal(kept.outcome, 'rewrite');
    assert.equal(kept.backupRequired, false);
    // ID 消失（B が消える）→ バックアップ必須。
    const lost = (await planWrite(file, session(block(A)), 'session')).plan;
    assert.equal(lost.outcome, 'rewrite');
    assert.equal(lost.backupRequired, true);
  } finally { rmrf(dir); }
});

// ---- commitPlan の JIT バックアップ（§8.5 step 4、R2-4） ------------------
// プラン確定からコミットまでの間に外部変更が入り、再プランが「ID 消失あり」の
// rewrite になった場合は、commitPlan 自身が書き込み前に backupDir へバックアップ
// を取得・検証してから書く（競合時の最後の安全柵）。ID が保たれる再プランでは
// バックアップしない。

test('R2-4: 再プランが ID 消失ありの rewrite になる場合、commitPlan が書き込み前に JIT バックアップする', async () => {
  const dir = mkTmp('ccx-bkp-jit-');
  const file = path.join(dir, 'ccxlog.md');
  const backupDir = path.join(dir, 'bak');
  try {
    await commitPlan((await planWrite(file, agg(block(A)), 'aggregate')).plan, { dryRun: false, alreadyBackedUp: false });
    // append 級のプラン（バックアップ不要）を確定しておく。
    const next = agg(block(A) + block(B));
    const plan = (await planWrite(file, next, 'aggregate')).plan;
    assert.equal(plan.outcome, 'append');
    assert.equal(plan.backupRequired, false);
    // コミット前に外部プロセスがファイルを変更し、next に無い ID C が現れる。
    // 再プランは「C が失われる」＝ ID 消失ありの rewrite になる。
    const external = agg(block(A) + block(C));
    fs.writeFileSync(file, external, 'utf-8');
    const res = await commitPlan(plan, { dryRun: false, alreadyBackedUp: false, backupDir });
    assert.equal(res.error, undefined);
    assert.equal(res.result, 'rewrite');
    // 書き込み前（外部変更後）の内容がバックアップされ、その後 next が書かれる。
    assert.equal(fs.readFileSync(path.join(backupDir, 'ccxlog.md'), 'utf-8'), external);
    assert.equal(fs.readFileSync(file, 'utf-8'), next);
  } finally { rmrf(dir); }
});

test('R2-4: 再プランが ID 保持の rewrite になる場合は JIT バックアップされない', async () => {
  const dir = mkTmp('ccx-bkp-jit-');
  const file = path.join(dir, 'ccxlog.md');
  const backupDir = path.join(dir, 'bak');
  try {
    const next = agg(block(A) + block(B));
    await commitPlan((await planWrite(file, next, 'aggregate')).plan, { dryRun: false, alreadyBackedUp: false });
    // 同一内容の noop 級プランを確定しておく。
    const plan = (await planWrite(file, next, 'aggregate')).plan;
    assert.equal(plan.outcome, 'noop');
    // 外部変更で並び順だけ入れ替わる → 再プランは rewrite だが ID は全保持。
    fs.writeFileSync(file, agg(block(B) + block(A)), 'utf-8');
    const res = await commitPlan(plan, { dryRun: false, alreadyBackedUp: false, backupDir });
    assert.equal(res.error, undefined);
    assert.equal(res.result, 'rewrite');
    assert.equal(fs.existsSync(backupDir), false); // バックアップは作られない
    assert.equal(fs.readFileSync(file, 'utf-8'), next);
  } finally { rmrf(dir); }
});
