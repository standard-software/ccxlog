// サブエージェント記録の探索（v1.5.0 / § includeSidechain）:
// 新しめの Claude Code は subagent の会話を
// `<ルート>/<セッションID>/subagents/*.jsonl` に isSidechain:true 付きで保存する。
// includeSidechain 有効時のみこのレイアウトを探索し、追加セッションとして描画する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  mkTmp, rmrf, runCli, writeClaudeSession, claudeQA, countPairs, writeConfig,
} from './helpers.mjs';

const SESS = '14157c8b-9332-490f-bb5b-bdaf9d6492e1';

// 本体ペア（11:03）より前の時刻にして、有効化時に「時系列途中への挿入」となる
// ケース（= v1.4.0 の ID 追加のみ・バックアップなし書き換え）を検証できるようにする
function sidechainQA(projectPath, { q = 'サブエージェントへの指示', a = 'サブエージェントの報告', ts = '2026-05-27T10:00:00.000Z' } = {}) {
  return [
    { type: 'user', uuid: 'sub-u1', parentUuid: null, timestamp: ts, cwd: projectPath, version: '1.0.0',
      gitBranch: 'main', isSidechain: true, message: { role: 'user', content: q } },
    { type: 'assistant', uuid: 'sub-a1', parentUuid: 'sub-u1', timestamp: ts, cwd: projectPath, version: '1.0.0',
      gitBranch: 'main', isSidechain: true,
      message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: a }], usage: { input_tokens: 1, output_tokens: 2 } } },
  ];
}

function scaffold() {
  const home = mkTmp('ccx-home-');
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const out = path.join(project, 'CCXLOG');
  writeClaudeSession(home, project, `${SESS}.jsonl`, claudeQA(project));
  writeClaudeSession(home, project, path.join(SESS, 'subagents', 'agent-a5b95863.jsonl'), sidechainQA(project));
  // subagents/ の直下より深い階層と、subagents を持たない兄弟ディレクトリは対象外
  writeClaudeSession(home, project, path.join(SESS, 'subagents', 'nested', 'agent-deep.jsonl'),
    sidechainQA(project, { q: 'DEEP-NESTED-MUST-NOT-APPEAR' }));
  writeClaudeSession(home, project, path.join('memory', 'notes.jsonl'), claudeQA(project, { q: 'MEMORY-DIR-MUST-NOT-APPEAR', uuid: 'u-mem' }));
  return { home, project, out, cleanup: () => rmrf(home) };
}

test('subagents: not discovered when includeSidechain is off (default)', () => {
  const s = scaffold();
  try {
    const r = runCli([s.project, '-cc'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    const file = path.join(s.out, 'cclog.md');
    assert.equal(countPairs(file), 1);
    assert.doesNotMatch(fs.readFileSync(file, 'utf-8'), /サブエージェントへの指示/);
  } finally { s.cleanup(); }
});

test('subagents: includeSidechain=true renders subagent transcripts as extra sessions', () => {
  const s = scaffold();
  try {
    writeConfig(s.out, { claude: { includeSidechain: true } });
    const r = runCli([s.project, '-cc', '--verbose'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    const text = fs.readFileSync(path.join(s.out, 'cclog.md'), 'utf-8');
    assert.equal(countPairs(path.join(s.out, 'cclog.md')), 2);
    assert.match(text, /サブエージェントへの指示/);
    assert.match(text, /サブエージェントの報告/);
    // subagents/ 直下のみ。深い階層と memory/ は拾わない
    assert.doesNotMatch(text, /DEEP-NESTED-MUST-NOT-APPEAR/);
    assert.doesNotMatch(text, /MEMORY-DIR-MUST-NOT-APPEAR/);
  } finally { s.cleanup(); }
});

test('subagents: per-session mode writes a file with the __subagents__ session id', () => {
  const s = scaffold();
  try {
    writeConfig(s.out, { claude: { includeSidechain: true } });
    const r = runCli([s.project, '-cc', '--per-session'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    const files = fs.readdirSync(s.out).filter(f => f.startsWith('cclog_'));
    const subFile = files.find(f => f.includes('__subagents__agent-a5b95863'));
    assert.ok(subFile, `subagent per-session file not found in: ${files.join(', ')}`);
    assert.match(fs.readFileSync(path.join(s.out, subFile), 'utf-8'), /サブエージェントの報告/);
  } finally { s.cleanup(); }
});

test('subagents: enabling the option later adds ids only and creates no backup', () => {
  const s = scaffold();
  try {
    let r = runCli([s.project, '-cc'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    const before = fs.readFileSync(path.join(s.out, 'cclog.md'), 'utf-8');
    const beforeIds = before.match(/ccxlogid:[0-9a-f]{24}/g) ?? [];

    writeConfig(s.out, { claude: { includeSidechain: true } });
    r = runCli([s.project, '-cc'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[rewrite\]/);
    assert.doesNotMatch(r.stdout, /Backed up/);
    assert.ok(!fs.existsSync(path.join(s.out, 'backup_CCXLOG_md_auto')), 'no backup dir expected');

    const after = fs.readFileSync(path.join(s.out, 'cclog.md'), 'utf-8');
    for (const id of beforeIds) assert.ok(after.includes(id), `existing id ${id} must survive`);
    assert.equal(countPairs(path.join(s.out, 'cclog.md')), 2);
  } finally { s.cleanup(); }
});
