// Codex cwd プリフィルタのガードテスト（R4 完成版）。
// プリフィルタが除外して良いのは「確実にプロジェクトに属さない」ファイル
// だけであり、cwd 不明・未知形式・明示ルート・走査 I/O エラー・走査中更新は
// 必ず通常解析へ回ることを固定する。
// 実経路（実ファイル・実走査）テストは回帰検出のため、scanner 注入テストは
// タイミング・故障の決定的再現のため — 両方を持つ（R4 方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  workspace, writeConfig, writeCodexSession, writeJsonl, codexQA, run, read,
} from './helpers.mjs';
import { extractCodexCwdRecord } from '../dist/sources/codex/jsonlReader.js';
import { mayBelong, prefilterCodexFiles, scanCodexCwds } from '../dist/sources/codex/cwdScanner.js';
import { canonicalPath } from '../dist/lib/pathUtils.js';

// FilterContext をテスト用に構築する（index.ts が組むものと同じ形）。
async function mkCtx(projectPath, { includeSubdirectories = false } = {}) {
  const canon = await canonicalPath(projectPath);
  return {
    projectPath,
    wantedCwds: new Set([canon]),
    includeSubdirectories,
    canonicalProjectPath: canon,
  };
}

function stdFile(filePath) {
  return { filePath, root: { dir: path.dirname(filePath), origin: 'standard', stableRootKey: 'std', recursive: true } };
}

test('extractCodexCwdRecord: cwd を持つのは session_meta / turn_context だけ（形式知識の一元化）', () => {
  assert.deepEqual(extractCodexCwdRecord({ type: 'session_meta', payload: { cwd: '/work/one' } }),
    { recognized: true, cwd: '/work/one' });
  assert.deepEqual(extractCodexCwdRecord({ type: 'turn_context', payload: { cwd: '/work/two' } }),
    { recognized: true, cwd: '/work/two' });
  // 既知形式で cwd 無し → recognized のみ（cwd 未観測として扱われる）。
  assert.deepEqual(extractCodexCwdRecord({ type: 'session_meta', payload: {} }), { recognized: true });
  // event_msg などの cwd らしきものは形式知識の対象外（未知扱い）。
  assert.deepEqual(extractCodexCwdRecord({ type: 'event_msg', payload: { type: 'user_message', cwd: '/noise' } }),
    { recognized: false });
  assert.deepEqual(extractCodexCwdRecord(null), { recognized: false });
  assert.deepEqual(extractCodexCwdRecord('not-an-object'), { recognized: false });
});

test('mayBelong: 属するファイルは true / 属さないファイルは false', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const belonging = path.join(ws.root, 'belonging.jsonl');
  writeJsonl(belonging, codexQA(ws.project));
  assert.equal(await mayBelong(stdFile(belonging), ctx), true);

  const unrelated = path.join(ws.root, 'unrelated.jsonl');
  writeJsonl(unrelated, codexQA(path.join(ws.root, 'other-project')));
  assert.equal(await mayBelong(stdFile(unrelated), ctx), false);
});

test('mayBelong: session_meta が別プロジェクトでも turn_context の cwd で属すると判定（cwd 移動の単体）', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const moved = path.join(ws.root, 'moved.jsonl');
  const records = codexQA(ws.project);
  // セッションは cwd を移動し得る。session_meta だけを見ると偽陰性になる
  // ケース — turn_context の cwd で「属する」と判定しなければならない。
  records[0].payload.cwd = path.join(ws.root, 'other-project');
  writeJsonl(moved, records);
  assert.equal(await mayBelong(stdFile(moved), ctx), true);
});

test('mayBelong: cwd を1つも持たないファイルは除外せず通常解析へフォールバック', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const noCwd = path.join(ws.root, 'no-cwd.jsonl');
  writeJsonl(noCwd, [
    { type: 'event_msg', payload: { type: 'user_message', message: 'Q' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'A' } },
  ]);
  assert.equal(await mayBelong(stdFile(noCwd), ctx), true);
});

test('mayBelong: 未知形式（壊れた行だけ）のファイルもフォールバックで残す', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const broken = path.join(ws.root, 'broken.jsonl');
  writeJsonl(broken, ['{ malformed "cwd" not json', 'just text']);
  assert.equal(await mayBelong(stdFile(broken), ctx), true);
});

test('mayBelong: 未知レコード型の payload.cwd らしき値（unknownFormat）は除外の根拠を放棄して残す', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const future = path.join(ws.root, 'future.jsonl');
  writeJsonl(future, [
    // 既知形式だけを見れば「無関係プロジェクト」だが…
    { type: 'session_meta', payload: { cwd: path.join(ws.root, 'other-project') } },
    // …将来形式を模した未知レコード型が cwd らしき値を持つため、除外しない。
    { type: 'future_context', payload: { cwd: ws.project } },
  ]);
  assert.equal(await mayBelong(stdFile(future), ctx), true,
    '未知形式の cwd を認識できない時は「除外」側へ倒れてはならない');
});

test('mayBelong: 明示 extraLogDirs ルートのファイルは cwd を見ずに必ず残す', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  // 存在しないパスでも true が返る＝ファイルを読まずに信頼している証拠。
  const ghost = { filePath: path.join(ws.root, 'ghost.jsonl'), root: { dir: ws.root, origin: 'extra', stableRootKey: 'x', recursive: true } };
  assert.equal(await mayBelong(ghost, ctx), true);
});

test('mayBelong: 走査 I/O エラーは除外せず通常解析へフォールバック（CLI 全体を落とさない）', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  // ディレクトリを .jsonl として渡す: stat（走査前 snapshot）は成功するが、
  // 読み取りは EISDIR 等で必ず失敗する＝走査中 I/O エラーの決定的な再現。
  const dirAsFile = path.join(ws.root, 'dir-as-file.jsonl');
  fs.mkdirSync(dirAsFile);
  assert.equal(await mayBelong(stdFile(dirAsFile), ctx), true,
    '走査例外は catch して「残す」へ倒し、reject で実行全体を落とさないこと');
});

test('mayBelong: 走査中の追記（無関係 cwd 走査後に対象 cwd 追記）は通常解析へ戻す', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const live = path.join(ws.root, 'live.jsonl');
  // 走査時点では無関係 cwd しか持たないライブファイル。
  writeJsonl(live, codexQA(path.join(ws.root, 'other-project')));
  // 「実走査の完了直後（走査後 snapshot 照合の前）に対象プロジェクトの
  // ターンが追記される」を、実走査 scanCodexCwds を包む scanner 注入で
  // 決定的に再現する（走査自体は実ファイル・実 forEachLine を通る）。
  let scanned = null;
  const scanThenAppend = async (filePath, c) => {
    const scan = await scanCodexCwds(filePath, c);   // 実走査
    scanned = scan;
    fs.appendFileSync(live,
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 't2', cwd: ws.project } }) + '\n');
    return scan;
  };
  assert.equal(await mayBelong(stdFile(live), ctx, scanThenAppend), true,
    '走査前後の snapshot 照合が追記を検出し、除外せず通常解析へ戻すこと');
  // 前提確認: 実走査は本当に「無関係 cwd のみ」を観測していた
  // （＝snapshot 照合が働かなければ除外されていた状況だったこと）。
  assert.equal(scanned.matchedFast, false);
  assert.equal(scanned.unknownFormat, false);
  assert.equal(scanned.cwds.length > 0, true);
});

test('mayBelong: 注入 scanner の例外もフォールバック（走査失敗の判定単体）', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const target = path.join(ws.root, 'target.jsonl');
  // ファイル自体は「確実に無関係」= scanner が成功すれば false になる内容。
  writeJsonl(target, codexQA(path.join(ws.root, 'other-project')));
  const failingScanner = async () => { throw new Error('injected scan failure'); };
  assert.equal(await mayBelong(stdFile(target), ctx, failingScanner), true,
    '走査が失敗したファイルを除外してはならない（catch → 通常解析へ）');
});

test('scanCodexCwds: CwdScanResult の境界（観測のみ・判定しない）を固定する', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const other = path.join(ws.root, 'other-project');

  // 無関係 cwd ＋ cwd らしき値を持つ未知形式の同居ファイル。
  const mixed = path.join(ws.root, 'mixed.jsonl');
  writeJsonl(mixed, [
    { type: 'session_meta', payload: { cwd: other } },
    { type: 'future_context', payload: { cwd: ws.project } },
  ]);
  const mixedScan = await scanCodexCwds(mixed, ctx);
  assert.deepEqual(mixedScan,
    { cwds: [other], recognized: true, unknownFormat: true, matchedFast: false },
    '未知形式は unknownFormat として報告し、cwds には既知形式の cwd だけを入れる');

  // 対象 cwd を持つファイル → matchedFast で走査を打ち切る。
  const belonging = path.join(ws.root, 'belonging.jsonl');
  writeJsonl(belonging, codexQA(ws.project));
  const fastScan = await scanCodexCwds(belonging, ctx);
  assert.equal(fastScan.matchedFast, true);

  // I/O エラー（ディレクトリを走査）は握り潰さず伝播する契約
  // （フォールバック判断は mayBelong の責務）。
  const dirAsFile = path.join(ws.root, 'scan-dir.jsonl');
  fs.mkdirSync(dirAsFile);
  await assert.rejects(() => scanCodexCwds(dirAsFile, ctx));
});

test('prefilterCodexFiles: 確実に無関係なファイルだけを除外し、発見順を維持する', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const relevant = path.join(ws.root, 'relevant.jsonl');
  const irrelevant = path.join(ws.root, 'irrelevant.jsonl');
  const noCwd = path.join(ws.root, 'no-cwd.jsonl');
  const unknown = path.join(ws.root, 'unknown.jsonl');
  writeJsonl(relevant, [{ type: 'session_meta', payload: { cwd: ws.project } }]);
  writeJsonl(irrelevant, [{ type: 'session_meta', payload: { cwd: path.join(ws.root, 'other-project') } }]);
  writeJsonl(noCwd, [{ type: 'event_msg', payload: { type: 'user_message', message: 'Q' } }]);
  writeJsonl(unknown, [{ type: 'future_context', payload: { cwd: path.join(ws.root, 'other-project') } }]);
  const files = [relevant, irrelevant, noCwd, unknown].map(stdFile);
  const kept = await prefilterCodexFiles(files, ctx);
  assert.deepEqual(kept.map(f => f.filePath), [relevant, noCwd, unknown],
    '除外は irrelevant だけ・残りは入力順のまま（決定的な出力順序）');
});

test('標準配下の Codex ファイルは全 cwd 文脈（session_meta＋turn_context）で事前フィルタされる', t => {
  const ws = workspace(t);
  const unrelated = path.join(ws.root, 'unrelated-project');

  writeCodexSession(ws.home, 'relevant.jsonl',
    codexQA(ws.project, { sessionId: 'relevant', q: 'directly relevant' }));
  writeCodexSession(ws.home, 'irrelevant.jsonl',
    codexQA(unrelated, { sessionId: 'irrelevant', q: 'must not be fully parsed' }));

  const laterRelevant = codexQA(ws.project, {
    sessionId: 'later-relevant',
    q: 'relevant through turn context',
  });
  // セッションは cwd を移動し得る。session_meta だけを見ると偽陰性になる
  // ケース — スキャナは全 turn_context も見なければならない。
  laterRelevant[0].payload.cwd = unrelated;
  writeCodexSession(ws.home, 'later-relevant.jsonl', laterRelevant);

  writeConfig(ws.out, { includeSubdirectories: false });
  const r = run([ws.project, '--out', ws.out, '-cx', '--verbose'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[codex\] files: 3, fully read: 2, sessions kept: 2/);
  const md = read(path.join(ws.out, 'cxlog.md'));
  assert.match(md, /directly relevant/);
  assert.match(md, /relevant through turn context/);
  assert.doesNotMatch(md, /must not be fully parsed/);
});

test('E2E: cwd 不明ファイルは fully read に数えられ、出力は従来挙動と一致する', t => {
  const ws = workspace(t);
  writeCodexSession(ws.home, 'relevant.jsonl',
    codexQA(ws.project, { sessionId: 'relevant', q: 'kept question' }));
  // cwd を持たないファイル: プリフィルタでは除外されず（フォールバック）、
  // 通常解析の結果 belongs=false で従来どおり出力から外れる。
  writeCodexSession(ws.home, 'no-cwd.jsonl', [
    { type: 'event_msg', timestamp: '2026-05-27T11:04:49.000Z', payload: { type: 'user_message', message: 'orphan' } },
  ]);
  writeConfig(ws.out, { includeSubdirectories: false });
  const r = run([ws.project, '--out', ws.out, '-cx', '--verbose'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  // files: 2 のうち、除外できるのは「確実に属さない」ファイルだけなので
  // fully read は 2（cwd 不明ファイルも全パースへ回る）。
  assert.match(r.stdout, /\[codex\] files: 2, fully read: 2, sessions kept: 1/);
  const md = read(path.join(ws.out, 'cxlog.md'));
  assert.match(md, /kept question/);
  assert.doesNotMatch(md, /orphan/);
});
