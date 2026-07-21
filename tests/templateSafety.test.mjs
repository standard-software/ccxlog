// §7.2 template safety end to end: progress modes, HTML-comment defanging,
// literal replacement, unknown/%Source% warnings, bundled japanese template.
// Ported from old-develop template-safety.test.mjs, adapted to new-develop
// wording (the both-progress advisory is emitted in all modes here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  run, workspace, writeConfig, writeJsonl, writeRaw, read, claudeQA,
} from './helpers.mjs';

// A claude session with an interim assistant turn (progress) then a final one.
function claudeWithProgress(project, { question = 'q', interim = 'interim step', answer = 'final answer' } = {}) {
  const ts = '2026-05-27T11:00:00.000Z';
  return [
    { type: 'user', uuid: 'u', parentUuid: null, timestamp: ts, cwd: project, message: { role: 'user', content: question } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u', timestamp: ts, cwd: project, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: interim }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: ts, cwd: project, message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: answer }] } },
  ];
}

function setup(t, files, cfg = {}) {
  const ws = workspace(t);
  for (const [name, events] of files) writeJsonl(path.join(ws.ccLogs, name), events);
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] }, ...cfg });
  return ws;
}

test('no-progress template omits progress; a with-progress template includes it', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'), claudeWithProgress(ws.project));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });

  // Default (english.md) has no progress placeholder.
  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);
  assert.doesNotMatch(read(path.join(ws.out, 'cclog.md')), /interim step/);

  // Point config at the bundled with-progress template (packageRoot resolution).
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] }, template: 'templates/english-with-progress.md' });
  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);
  assert.match(read(path.join(ws.out, 'cclog.md')), /interim step/);
});

test('a template with both %Progress% and %ProgressFull% substitutes both and warns', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'), claudeWithProgress(ws.project));
  writeRaw(path.join(ws.out, 'templates', 'both.md'),
    '<!-- ccxlog-pair:%PairId% -->\n# %DateTime% [%Source%]\nSummary:%Progress%\nFull:%ProgressFull%\nA:%Answer%\n\n----------------------------------------\n\n');
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] }, template: 'templates/both.md' });

  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /both %Progress% and %ProgressFull%/);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.match(md, /Summary:.*interim step/s);
  assert.match(md, /Full:.*interim step/s);
});

test('HTML comment tokens in question/answer are neutralized (both <!-- and -->)', t => {
  const ws = setup(t, [['a.jsonl', []]]);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'),
    claudeQA(ws.project, { q: 'look <!-- here', a: 'done --> now' }));
  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.match(md, /look <! -- here/);   // <!-- defanged
  assert.match(md, /done -- > now/);     // --> defanged
});

test('regex replacement tokens in the body are kept literal ($&, $1, $$)', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'),
    claudeQA(ws.project, { q: 'price $$ and $& then $1', a: 'ok' }));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });
  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);
  assert.match(read(path.join(ws.out, 'cclog.md')), /price \$\$ and \$& then \$1/);
});

test('a template without %Source% and with an unknown placeholder warns (generation continues)', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'), claudeQA(ws.project));
  writeRaw(path.join(ws.out, 'templates', 'weird.md'),
    '<!-- ccxlog-pair:%PairId% -->\n# %DateTime%\n%Question%\n%Bogus%\n%Answer%\n\n----------------------------------------\n\n');
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] }, template: 'templates/weird.md' });
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  // Missing %Source% is warned in ALL modes; the unknown-placeholder warning is
  // verbose-only, so it must NOT appear on a non-verbose run.
  assert.match(r.stderr, /no %Source%/);
  assert.doesNotMatch(r.stderr, /unknown placeholder/);
  // The unknown placeholder is still left verbatim in the output.
  assert.match(read(path.join(ws.out, 'cclog.md')), /%Bogus%/);

  // With --verbose the unknown-placeholder warning appears.
  const v = run([ws.project, '--out', ws.out, '-cc', '--verbose'], { home: ws.home });
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stderr, /unknown placeholder/);
});

test('placeholders inside question/answer content are kept literal (not re-substituted)', t => {
  const ws = workspace(t);
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'), claudeQA(ws.project, {
    q: 'What do %Question%, %Answer% and %Model% mean? And %Tokens% / %GitBranch%?',
    a: 'Even writing %Question% and %Answer% in the reply stays literal.',
  }));
  writeConfig(ws.out, { claude: { extraLogDirs: [ws.ccLogs] } });
  const r = run([ws.project, '--out', ws.out, '-cc'], { home: ws.home });
  assert.equal(r.status, 0, r.stderr);
  const md = read(path.join(ws.out, 'cclog.md'));
  // Single-pass render: %Name% strings that appear in the substituted VALUE
  // (the question / answer body) must never be re-substituted.
  assert.match(md, /What do %Question%, %Answer% and %Model% mean\? And %Tokens% \/ %GitBranch%\?/);
  assert.match(md, /Even writing %Question% and %Answer% in the reply stays literal\./);
  // The genuine template placeholder is still substituted (meta Model line).
  assert.match(md, /Model=claude-opus-4-8/);
});

test('bundled japanese template keeps %Source% tokens and renders headings', t => {
  const ws = setup(t, [['a.jsonl', []]], { template: 'templates/japanese.md' });
  writeJsonl(path.join(ws.ccLogs, 'a.jsonl'), claudeQA(ws.project));
  assert.equal(run([ws.project, '--out', ws.out, '-cc'], { home: ws.home }).status, 0);
  const md = read(path.join(ws.out, 'cclog.md'));
  assert.match(md, /\[ClaudeCode\]/);
  assert.match(md, /Source=ClaudeCode/);
  assert.match(md, /## 質問/);
});
