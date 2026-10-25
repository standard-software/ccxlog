// Log homes (v1.14.0): logs written under another Claude / Codex config dir —
// ~/.claude-work when Claude ran with CLAUDE_CONFIG_DIR, ~/.codex-work for
// CODEX_HOME — are found without extraLogDirs, attributed to the project the
// same way as the default dir's, and never doubled when a session sits under
// two of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  run, runCli, workspace, writeConfig, writeJsonl, read, encodeCwd, claudeQA, codexQA, countPairs,
} from './helpers.mjs';

function claudeFile(home, cfgDir, project, name) {
  return path.join(home, cfgDir, 'projects', encodeCwd(project), name);
}

function codexFile(home, cfgDir, name) {
  return path.join(home, cfgDir, 'sessions', '2026', '05', '27', name);
}

// A later assistant message in the same turn: the pair's answer changes.
function laterAnswer(project, uuid, text, ts = '2026-05-27T11:03:59.000Z') {
  return {
    type: 'assistant', uuid: `a2-${uuid}`, parentUuid: `a-${uuid}`, timestamp: ts, cwd: project,
    version: '1.0.0', gitBranch: 'main',
    message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text }] },
  };
}

function ids(md) {
  return [...md.matchAll(/<!-- (ccxlogid:[0-9a-f]{24})/g)].map(m => m[1]);
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

test('a session only under another Claude config dir reaches ccxlog.md without extraLogDirs', t => {
  const ws = workspace(t);
  writeJsonl(claudeFile(ws.home, '.claude', ws.project, 'a.jsonl'),
    claudeQA(ws.project, { uuid: 'd1', q: 'asked with the default account' }));
  writeJsonl(claudeFile(ws.home, '.claude-work', ws.project, 'b.jsonl'),
    claudeQA(ws.project, { uuid: 'w1', q: 'asked with the work account', ts: '2026-05-27T11:05:00.000Z' }));
  const r = run([ws.project, '--out', ws.out, '-cc', '--verbose'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.match(md, /asked with the default account/);
  assert.match(md, /asked with the work account/);
  assert.match(r.stdout, /\[claude\] log homes:/);
  assert.ok(r.stdout.includes(path.join(ws.home, '.claude-work')), r.stdout);
});

test('another project under the other config dir is not mixed in; a sibling project neither', t => {
  const ws = workspace(t);
  const other = path.join(ws.root, 'other');
  const sibling = `${ws.project}-backup`;
  const nested = path.join(ws.project, 'sub');
  fs.mkdirSync(other, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  writeJsonl(claudeFile(ws.home, '.claude-work', ws.project, 'mine.jsonl'),
    claudeQA(ws.project, { uuid: 'm1', q: 'mine' }));
  writeJsonl(claudeFile(ws.home, '.claude-work', other, 'theirs.jsonl'),
    claudeQA(other, { uuid: 'o1', q: 'other project' }));
  writeJsonl(claudeFile(ws.home, '.claude-work', sibling, 'sib.jsonl'),
    claudeQA(sibling, { uuid: 's1', q: 'sibling project' }));
  writeJsonl(claudeFile(ws.home, '.claude-work', nested, 'nested.jsonl'),
    claudeQA(nested, { uuid: 'n1', q: 'nested project', ts: '2026-05-27T11:06:00.000Z' }));
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.match(md, /mine/);
  assert.match(md, /nested project/);           // includeSubdirectories reaches every home
  assert.doesNotMatch(md, /other project/);
  assert.doesNotMatch(md, /sibling project/);
});

test('a .claude* entry without projects/ is not a config dir and is ignored', t => {
  const ws = workspace(t);
  fs.mkdirSync(path.join(ws.home, '.claude-code-viewer', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(ws.home, '.claude.json'), '{}', 'utf-8');
  writeJsonl(claudeFile(ws.home, '.claude', ws.project, 'a.jsonl'), claudeQA(ws.project, { uuid: 'd1' }));
  const r = run([ws.project, '--out', ws.out, '-cc', '--verbose'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('.claude-code-viewer'), r.stdout);
  assert.ok(!r.stdout.includes(`${path.join(ws.home, '.claude.json')} (`), r.stdout);
  assert.equal(countPairs(path.join(ws.out, 'cclog.md')), 1);
});

test('with no config dir at all the run reports the default places, as before', t => {
  const ws = workspace(t);
  const r = run([ws.project, '--out', ws.out], { home: ws.home });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /No pairs found/);
  assert.ok(r.stderr.includes(path.join(ws.home, '.codex', 'sessions')), r.stderr);
});

test('the same session under two config dirs is written once, with what only the later copy has', t => {
  const ws = workspace(t);
  const shared = claudeQA(ws.project, { uuid: 's1', q: 'shared question', a: 'early answer' });
  writeJsonl(claudeFile(ws.home, '.claude', ws.project, 'sess.jsonl'), shared);
  let r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const before = ids(read(path.join(ws.out, 'cclog.md')));
  assert.equal(before.length, 1);

  // The work dir holds the same history, continued: the turn went on and a new
  // question followed. Either copy may sort first.
  writeJsonl(claudeFile(ws.home, '.claude-work', ws.project, 'sess.jsonl'), [
    ...shared,
    laterAnswer(ws.project, 's1', 'final answer'),
    ...claudeQA(ws.project, { uuid: 's2', q: 'only in the later copy', a: 'new answer', ts: '2026-05-27T11:07:00.000Z' }),
  ]);
  r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.equal(occurrences(md, 'shared question'), 1, md);
  assert.match(md, /final answer/);
  assert.match(md, /only in the later copy/);
  // The shared block kept its id, so nothing looks lost and no backup is taken.
  assert.equal(ids(md)[0], before[0]);
  assert.ok(!fs.existsSync(path.join(ws.out, 'backup_CCXLOG_md')), 'no backup expected');
});

test('per-session output writes a session found under two config dirs as one file', t => {
  const ws = workspace(t);
  const shared = claudeQA(ws.project, { uuid: 's1', q: 'shared question' });
  writeJsonl(claudeFile(ws.home, '.claude', ws.project, 'sess.jsonl'), shared);
  writeJsonl(claudeFile(ws.home, '.claude-work', ws.project, 'sess.jsonl'), [
    ...shared,
    ...claudeQA(ws.project, { uuid: 's2', q: 'only in the later copy', ts: '2026-05-27T11:07:00.000Z' }),
  ]);
  const r = run([ws.project, '--out', ws.out, '-cc', '--per-session'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const files = fs.readdirSync(ws.out).filter(f => f.endsWith('.md'));
  assert.deepEqual(files, ['cclog_sess.md']);
  const md = read(path.join(ws.out, 'cclog_sess.md'));
  assert.equal(occurrences(md, 'shared question'), 1, md);
  assert.match(md, /only in the later copy/);
});

test('extraLogDirs naming the other config dir still works, and gives the same output as without it', t => {
  const ws = workspace(t);
  writeJsonl(claudeFile(ws.home, '.claude-work', ws.project, 'b.jsonl'),
    claudeQA(ws.project, { uuid: 'w1', q: 'asked with the work account' }));
  let r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const without = read(path.join(ws.out, 'cclog.md'));

  const out2 = path.join(ws.root, 'out2');
  writeConfig(out2, { claude: { extraLogDirs: [path.join(ws.home, '.claude-work', 'projects', encodeCwd(ws.project))] } });
  r = run([ws.project, '--out', out2, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(path.join(out2, 'cclog.md')), without);
});

test('CLAUDE_CONFIG_DIR outside the home directory is searched too', t => {
  const ws = workspace(t);
  const cfgDir = path.join(ws.root, 'elsewhere');
  writeJsonl(path.join(cfgDir, 'projects', encodeCwd(ws.project), 'e.jsonl'),
    claudeQA(ws.project, { uuid: 'e1', q: 'from the environment' }));
  const r = runCli([ws.project, '--out', ws.out, '-cc'], { home: ws.home, env: { CLAUDE_CONFIG_DIR: cfgDir } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(read(path.join(ws.out, 'cclog.md')), /from the environment/);
});

test('autoDiscover false and configDirGlobs limit the search', t => {
  const ws = workspace(t);
  writeJsonl(claudeFile(ws.home, '.claude-work', ws.project, 'w.jsonl'),
    claudeQA(ws.project, { uuid: 'w1', q: 'work dir' }));
  writeJsonl(claudeFile(ws.home, '.claude-zzz', ws.project, 'z.jsonl'),
    claudeQA(ws.project, { uuid: 'z1', q: 'zzz dir', ts: '2026-05-27T11:05:00.000Z' }));

  writeConfig(ws.out, { autoDiscover: false });
  let r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /No pairs found/);

  writeConfig(ws.out, { claude: { configDirGlobs: ['.claude-w*', 'bad/glob'] } });
  r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /claude\.configDirGlobs entry "bad\/glob"/);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.match(md, /work dir/);
  assert.doesNotMatch(md, /zzz dir/);
});

test('%Account% shows the account of the config dir each log came from', t => {
  const ws = workspace(t);
  fs.writeFileSync(path.join(ws.home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'me@default.example' } }), 'utf-8');
  writeJsonl(claudeFile(ws.home, '.claude', ws.project, 'a.jsonl'), claudeQA(ws.project, { uuid: 'd1', q: 'q-default' }));
  writeJsonl(claudeFile(ws.home, '.claude-work', ws.project, 'b.jsonl'),
    claudeQA(ws.project, { uuid: 'w1', q: 'q-work', ts: '2026-05-27T11:05:00.000Z' }));
  fs.writeFileSync(path.join(ws.home, '.claude-work', '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'me@work.example' } }), 'utf-8');
  const payload = Buffer.from(JSON.stringify({ email: 'cx@work.example' })).toString('base64url');
  writeJsonl(codexFile(ws.home, '.codex-work', 'rollout-x.jsonl'), codexQA(ws.project, { sessionId: 'cx1', q: 'q-codex' }));
  fs.writeFileSync(path.join(ws.home, '.codex-work', 'auth.json'),
    JSON.stringify({ tokens: { id_token: `e30.${payload}.sig` } }), 'utf-8');
  const tpl = path.join(ws.root, 'tpl.md');
  fs.writeFileSync(tpl, '<!-- %CcxlogId% -->\n# [%Source%@%Account%] %Question%\n\n', 'utf-8');
  writeConfig(ws.out, { template: tpl });
  const r = run([ws.project, '--out', ws.out], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'ccxlog.md'));
  assert.match(md, /\[ClaudeCode@me@default\.example\] q-default/);
  assert.match(md, /\[ClaudeCode@me@work\.example\] q-work/);
  assert.match(md, /\[Codex@cx@work\.example\] q-codex/);
});

test('Codex: another CODEX_HOME is searched and filtered by cwd; a copied rollout is not doubled', t => {
  const ws = workspace(t);
  const other = path.join(ws.root, 'other');
  fs.mkdirSync(other, { recursive: true });
  const rollout = codexQA(ws.project, { sessionId: 'cx-shared', q: 'codex shared question' });
  writeJsonl(codexFile(ws.home, '.codex', 'rollout-a.jsonl'), rollout);
  writeJsonl(codexFile(ws.home, '.codex-work', 'rollout-a.jsonl'), rollout);
  writeJsonl(codexFile(ws.home, '.codex-work', 'rollout-b.jsonl'),
    codexQA(ws.project, { sessionId: 'cx-work', q: 'codex work question', ts: '2026-05-27T11:09:00.000Z' }));
  writeJsonl(codexFile(ws.home, '.codex-work', 'rollout-c.jsonl'),
    codexQA(other, { sessionId: 'cx-other', q: 'codex other project' }));
  let r = run([ws.project, '--out', ws.out, '-cx'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cxlog.md'));
  assert.equal(occurrences(md, 'codex shared question'), 1, md);
  assert.match(md, /codex work question/);
  assert.doesNotMatch(md, /codex other project/);

  // An extraLogDirs root keeps its old meaning: trusted without a cwd filter.
  writeConfig(ws.out, { codex: { extraLogDirs: [path.join(ws.home, '.codex-work', 'sessions')] } });
  r = run([ws.project, '--out', ws.out, '-cx'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(path.join(ws.out, 'cxlog.md')), /codex other project/);

  r = runCli([ws.project, '--out', path.join(ws.root, 'out3'), '-cx'],
    { home: ws.home, env: { CODEX_HOME: path.join(ws.home, '.codex-work') } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(read(path.join(ws.root, 'out3', 'cxlog.md')), /codex work question/);
});
