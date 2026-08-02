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

test('extractCodexCwdRecord: only session_meta and turn_context carry cwd', () => {
  assert.deepEqual(extractCodexCwdRecord({ type: 'session_meta', payload: { cwd: '/work/one' } }),
    { recognized: true, cwd: '/work/one' });
  assert.deepEqual(extractCodexCwdRecord({ type: 'turn_context', payload: { cwd: '/work/two' } }),
    { recognized: true, cwd: '/work/two' });
  assert.deepEqual(extractCodexCwdRecord({ type: 'session_meta', payload: {} }), { recognized: true });
  assert.deepEqual(extractCodexCwdRecord({ type: 'event_msg', payload: { type: 'user_message', cwd: '/noise' } }),
    { recognized: false });
  assert.deepEqual(extractCodexCwdRecord(null), { recognized: false });
  assert.deepEqual(extractCodexCwdRecord('not-an-object'), { recognized: false });
});

test('mayBelong: keeps matching files and excludes non-matching files with cwd dependencies', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const belonging = path.join(ws.root, 'belonging.jsonl');
  writeJsonl(belonging, codexQA(ws.project));
  assert.equal((await mayBelong(stdFile(belonging), ctx)).keep, true);

  const other = path.join(ws.root, 'other-project');
  const unrelated = path.join(ws.root, 'unrelated.jsonl');
  writeJsonl(unrelated, codexQA(other));
  const verdict = await mayBelong(stdFile(unrelated), ctx);
  assert.equal(verdict.keep, false);
  assert.deepEqual(verdict.cwdDeps, [{ raw: other, canon: await canonicalPath(other) }]);
});

test('mayBelong: a matching turn_context cwd overrides an unrelated session_meta cwd', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const moved = path.join(ws.root, 'moved.jsonl');
  const records = codexQA(ws.project);
  records[0].payload.cwd = path.join(ws.root, 'other-project');
  writeJsonl(moved, records);
  assert.equal((await mayBelong(stdFile(moved), ctx)).keep, true);
});

test('mayBelong: files without any cwd fall back to normal parsing', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const noCwd = path.join(ws.root, 'no-cwd.jsonl');
  writeJsonl(noCwd, [
    { type: 'event_msg', payload: { type: 'user_message', message: 'Q' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'A' } },
  ]);
  assert.equal((await mayBelong(stdFile(noCwd), ctx)).keep, true);
});

test('mayBelong: files containing only malformed lines also fall back to normal parsing', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const broken = path.join(ws.root, 'broken.jsonl');
  writeJsonl(broken, ['{ malformed "cwd" not json', 'just text']);
  assert.equal((await mayBelong(stdFile(broken), ctx)).keep, true);
});

test('mayBelong: cwd-like values in unknown records prevent exclusion', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const future = path.join(ws.root, 'future.jsonl');
  writeJsonl(future, [
    { type: 'session_meta', payload: { cwd: path.join(ws.root, 'other-project') } },
    { type: 'future_context', payload: { cwd: ws.project } },
  ]);
  assert.equal((await mayBelong(stdFile(future), ctx)).keep, true,
    'an unrecognized cwd format must not cause exclusion');
});

test('mayBelong: files from explicit extraLogDirs roots are always kept without cwd scanning', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const ghost = { filePath: path.join(ws.root, 'ghost.jsonl'), root: { dir: ws.root, origin: 'extra', stableRootKey: 'x', recursive: true } };
  assert.equal((await mayBelong(ghost, ctx)).keep, true);
});

test('mayBelong: scan I/O errors fall back to normal parsing without failing the CLI', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const dirAsFile = path.join(ws.root, 'dir-as-file.jsonl');
  fs.mkdirSync(dirAsFile);
  assert.equal((await mayBelong(stdFile(dirAsFile), ctx)).keep, true,
    'scan exceptions must be caught and conservatively keep the file');
});

test('mayBelong: appending a matching cwd during scanning falls back to normal parsing', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const live = path.join(ws.root, 'live.jsonl');
  writeJsonl(live, codexQA(path.join(ws.root, 'other-project')));
  let scanned = null;
  const scanThenAppend = async (filePath, c) => {
    const scan = await scanCodexCwds(filePath, c);
    scanned = scan;
    fs.appendFileSync(live,
      JSON.stringify({ type: 'turn_context', payload: { turn_id: 't2', cwd: ws.project } }) + '\n');
    return scan;
  };
  assert.equal((await mayBelong(stdFile(live), ctx, scanThenAppend)).keep, true,
    'snapshot comparison must detect the append and avoid exclusion');
  assert.equal(scanned.matchedFast, false);
  assert.equal(scanned.unknownFormat, false);
  assert.equal(scanned.cwds.length > 0, true);
});

test('mayBelong: an injected scanner exception also falls back to normal parsing', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const target = path.join(ws.root, 'target.jsonl');
  writeJsonl(target, codexQA(path.join(ws.root, 'other-project')));
  const failingScanner = async () => { throw new Error('injected scan failure'); };
  assert.equal((await mayBelong(stdFile(target), ctx, failingScanner)).keep, true,
    'a file whose scan failed must not be excluded');
});

test('scanCodexCwds: CwdScanResult reports observations without making policy decisions', async t => {
  const ws = workspace(t);
  const ctx = await mkCtx(ws.project);
  const other = path.join(ws.root, 'other-project');

  const mixed = path.join(ws.root, 'mixed.jsonl');
  writeJsonl(mixed, [
    { type: 'session_meta', payload: { cwd: other } },
    { type: 'future_context', payload: { cwd: ws.project } },
  ]);
  const mixedScan = await scanCodexCwds(mixed, ctx);
  assert.deepEqual(mixedScan,
    { cwds: [other], recognized: true, unknownFormat: true, matchedFast: false },
    'unknown records set unknownFormat while cwds contains only known cwd values');

  const belonging = path.join(ws.root, 'belonging.jsonl');
  writeJsonl(belonging, codexQA(ws.project));
  const fastScan = await scanCodexCwds(belonging, ctx);
  assert.equal(fastScan.matchedFast, true);

  const dirAsFile = path.join(ws.root, 'scan-dir.jsonl');
  fs.mkdirSync(dirAsFile);
  await assert.rejects(() => scanCodexCwds(dirAsFile, ctx));
});

test('prefilterCodexFiles: excludes only definitely unrelated files and preserves discovery order', async t => {
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
  const { passed, excludedCwdDeps } = await prefilterCodexFiles(files, ctx);
  assert.deepEqual(passed.map(f => f.filePath), [relevant, noCwd, unknown],
    'only irrelevant files are excluded and the rest retain input order');
  assert.deepEqual([...excludedCwdDeps.keys()], [irrelevant]);
  assert.deepEqual(excludedCwdDeps.get(irrelevant),
    [{ raw: path.join(ws.root, 'other-project'), canon: await canonicalPath(path.join(ws.root, 'other-project')) }]);
});

test('standard Codex files are prefiltered using all session_meta and turn_context cwd values', t => {
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

test('E2E: files with unknown cwd count as fully read and preserve existing output behavior', t => {
  const ws = workspace(t);
  writeCodexSession(ws.home, 'relevant.jsonl',
    codexQA(ws.project, { sessionId: 'relevant', q: 'kept question' }));
  writeCodexSession(ws.home, 'no-cwd.jsonl', [
    { type: 'event_msg', timestamp: '2026-05-27T11:04:49.000Z', payload: { type: 'user_message', message: 'orphan' } },
  ]);
  writeConfig(ws.out, { includeSubdirectories: false });
  const r = run([ws.project, '--out', ws.out, '-cx', '--verbose'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[codex\] files: 2, fully read: 2, sessions kept: 1/);
  const md = read(path.join(ws.out, 'cxlog.md'));
  assert.match(md, /kept question/);
  assert.doesNotMatch(md, /orphan/);
});
