// 高速化で書き直した3箇所のガードテスト（R4 完成版）:
//   1. lineStream の行分割 — 8MB チャンク境界の改行・マルチバイト分断・
//      早期中断（early-stop）
//   2. lazyFileSha256 — メモ化・TOCTOU（解析後に変更・置換されたファイルを
//      重複確定に使わない。dev/ino による rename 置換の検出を含む）
//   3. テンプレートゲート — %Progress%/%ProgressFull% を参照しない
//      テンプレートでは Progress を構築しない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkTmp, rmrf } from './helpers.mjs';
import { forEachLine, READ_CHUNK_BYTES } from '../dist/lib/lineStream.js';
import { lazyFileSha256 } from '../dist/lib/pathUtils.js';
import { toUnifiedPair, formatPair } from '../dist/lib/markdownWriter.js';

// forEachLine の期待挙動: split('\n') と同じ行列（末尾の空要素だけ落とす）。
function splitReference(content) {
  const parts = content.split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

async function collectLines(file) {
  const lines = [];
  await forEachLine(file, l => { lines.push(l); });
  return lines;
}

// 実装の export を参照する（テスト側に値を複製すると、将来チャンクサイズを
// 変えた時に境界テストが黙って別の境界を試験するようになるため）。
const CHUNK = READ_CHUNK_BYTES;

// 解析時 snapshot（size/mtime/dev/ino）を stat から組み立てる。
function snapOf(file) {
  const st = fs.statSync(file);
  return { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino };
}

test('lineStream: 改行がチャンク境界ちょうどに来ても行は壊れない', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'boundary-newline.txt');
    // 1行目が CHUNK-1 バイト、その直後の '\n' が第1チャンクの最終バイト。
    const first = 'a'.repeat(CHUNK - 1);
    const content = `${first}\nsecond\nthird`;
    fs.writeFileSync(file, content, 'utf-8');
    const lines = await collectLines(file);
    assert.deepEqual(lines.map(l => l.length), [CHUNK - 1, 6, 5]);
    assert.deepEqual(lines, splitReference(content));
  } finally { rmrf(dir); }
});

test('lineStream: マルチバイト文字がチャンク境界で分断されても復元される', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'boundary-multibyte.txt');
    // 'あ' は UTF-8 で3バイト。CHUNK-1 バイトの ASCII の後に置くことで
    // 1バイト目が第1チャンク末尾、残り2バイトが第2チャンク先頭に分断される。
    const content = `${'x'.repeat(CHUNK - 1)}あ日本語\n二行目の内容`;
    fs.writeFileSync(file, content, 'utf-8');
    const lines = await collectLines(file);
    assert.deepEqual(lines, splitReference(content));
    assert.ok(lines[0].endsWith('あ日本語'), 'マルチバイト文字が化けてはならない');
  } finally { rmrf(dir); }
});

test('lineStream: 空行・CR・末尾改行の有無は split(\'\\n\') と完全一致', async () => {
  const dir = mkTmp();
  try {
    for (const content of ['a\n\nb\r\nc', 'a\n', 'a', '', '\n', 'a\nb\n']) {
      const file = path.join(dir, 'small.txt');
      fs.writeFileSync(file, content, 'utf-8');
      assert.deepEqual(await collectLines(file), splitReference(content), JSON.stringify(content));
    }
  } finally { rmrf(dir); }
});

test('lineStream: onLine が false を返すと読み込みを中断する（early-stop）', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'stop.txt');
    fs.writeFileSync(file, Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n'), 'utf-8');
    const seen = [];
    await forEachLine(file, l => {
      seen.push(l);
      if (seen.length === 3) return false;   // ここで中断
      return;
    });
    assert.deepEqual(seen, ['line-0', 'line-1', 'line-2'], '中断後にコールバックが呼ばれてはならない');
  } finally { rmrf(dir); }
});

test('lazyFileSha256: 未変更ファイルは正しい SHA-256 を返し、メモ化される', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'hash.jsonl');
    const body = '{"a":1}\n{"b":2}\n';
    fs.writeFileSync(file, body, 'utf-8');
    const lazy = lazyFileSha256(file, snapOf(file));
    const expected = crypto.createHash('sha256').update(Buffer.from(body, 'utf-8')).digest('hex');
    assert.equal(await lazy(), expected);
    // メモ化: 初回計算後にファイルが変わっても、同じ関数は同じ値を返す
    // （＝1ファイルにつき読み直しは最大1回）。
    fs.appendFileSync(file, 'more\n');
    assert.equal(await lazy(), expected);
  } finally { rmrf(dir); }
});

test('lazyFileSha256: メモ化は unlink 後の再取得でも同値（ファイルを再読込しない直接証明）', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'memo.jsonl');
    const body = 'memoized-content\n';
    fs.writeFileSync(file, body, 'utf-8');
    const lazy = lazyFileSha256(file, snapOf(file));
    const expected = crypto.createHash('sha256').update(Buffer.from(body, 'utf-8')).digest('hex');
    assert.equal(await lazy(), expected);
    // 初回計算後にファイル自体を削除してから再取得しても同値が返る
    // ＝2回目以降はディスクに一切触れないことの直接証明。
    fs.unlinkSync(file);
    assert.equal(await lazy(), expected);
  } finally { rmrf(dir); }
});

test('lazyFileSha256: 解析後に変更されたファイルは \'\' （重複と確認しない）', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'changed.jsonl');
    fs.writeFileSync(file, 'original\n', 'utf-8');
    const snap = snapOf(file);
    // 解析（stat 取得）とハッシュ計算の間に追記された = TOCTOU。
    fs.appendFileSync(file, 'appended after parse\n');
    const lazy = lazyFileSha256(file, snap);
    assert.equal(await lazy(), '');
  } finally { rmrf(dir); }
});

test('lazyFileSha256: サイズ不変でも mtime が変わっていれば \'\'', async () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'touched.jsonl');
    fs.writeFileSync(file, 'stable content\n', 'utf-8');
    const snap = snapOf(file);
    fs.utimesSync(file, new Date(), new Date(snap.mtimeMs + 5000));
    const lazy = lazyFileSha256(file, snap);
    assert.equal(await lazy(), '');
  } finally { rmrf(dir); }
});

test('lazyFileSha256: 同サイズ・同 mtime の別内容ファイルへの置換も dev/ino で検出して \'\'', async t => {
  const dir = mkTmp();
  try {
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    fs.writeFileSync(a, 'content-A\n', 'utf-8');
    fs.writeFileSync(b, 'content-B\n', 'utf-8');   // 同じバイト長・異なる内容
    const when = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(a, when, when);
    fs.utimesSync(b, when, when);
    const snap = snapOf(a);
    // cp -p 相当の rename 置換（サイズも mtime も元と一致する別実体）。
    fs.renameSync(b, a);
    fs.utimesSync(a, when, when);
    const after = snapOf(a);
    if (snap.ino === 0 || after.ino === snap.ino || after.mtimeMs !== snap.mtimeMs) {
      // ino が取れない・区別できないファイルシステムでは dev/ino 検出を
      // 検証できない（その環境では size/mtime のみと同等へ縮退する設計）。
      t.skip('このファイルシステムでは ino による実体の区別を検証できない');
      return;
    }
    assert.equal(after.size, snap.size, 'サイズは一致している前提の置換');
    assert.equal(await lazyFileSha256(a, snap)(), '',
      'size/mtime が同一でも ino の変化で「重複と確認しない」へ倒れること');
  } finally { rmrf(dir); }
});

test('lazyFileSha256: 読めないファイルは \'\' （保守的に両方残す側へ）', async () => {
  const lazy = lazyFileSha256(path.join(mkTmp(), 'no-such-file.jsonl'), { size: 1, mtimeMs: 1, dev: 0, ino: 0 });
  assert.equal(await lazy(), '');
});

// テンプレートゲート用の UnifiedPair を作り、Progress アクセサを呼び出し
// カウンタ付きに差し替える。
function mkCountingPair() {
  const pair = {
    questionEntry: { type: 'user', uuid: 'u1', timestamp: '2026-05-27T11:00:00Z', message: { role: 'user', content: 'Q' } },
    additionalQuestionEntries: [],
    progressEntries: [],
    finalAssistantEntry: { type: 'assistant', uuid: 'a1', timestamp: '2026-05-27T11:00:02Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] } },
  };
  const u = toUnifiedPair({
    pair, source: 'claude', sourceLabel: 'ClaudeCode', sessionId: 's', sessionName: '',
    sourceFile: '/x.jsonl', sourceFileRelativeId: 'claude/standard/std/x.jsonl',
    fileContentHash: async () => '', eventIdStream: [], questionOrdinal: 0,
  });
  const calls = { summary: 0, full: 0 };
  u.progressSummary = () => { calls.summary++; return 'S'; };
  u.progressFull = () => { calls.full++; return 'F'; };
  return { u, calls };
}

test('テンプレートゲート: Progress を参照しないテンプレートでは構築しない', () => {
  const { u, calls } = mkCountingPair();
  const out = formatPair(u, '%Question%\n%Answer%\n');
  assert.match(out, /Q/);
  assert.equal(calls.summary, 0);
  assert.equal(calls.full, 0);
});

test('テンプレートゲート: %Progress% は summary だけを、%ProgressFull% は full だけを構築する', () => {
  {
    const { u, calls } = mkCountingPair();
    const out = formatPair(u, '%Question%\n%Progress%\n');
    assert.match(out, /S/);
    assert.equal(calls.summary, 1);
    assert.equal(calls.full, 0, "'%Progress%' の判定が '%ProgressFull%' を誤発火させてはならない");
  }
  {
    const { u, calls } = mkCountingPair();
    const out = formatPair(u, '%Question%\n%ProgressFull%\n');
    assert.match(out, /F/);
    assert.equal(calls.summary, 0);
    assert.equal(calls.full, 1);
  }
});
