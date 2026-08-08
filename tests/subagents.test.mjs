// Claude Code side of the subagent display option (spec §15.2).
//
// Claude Code stores a subagent conversation in two different ways and both have
// to obey the same setting:
//   - INLINE, as `isSidechain: true` records mixed into the session log;
//   - as a SEPARATE `<session id>/subagents/*.jsonl` transcript, whose records
//     do not reliably carry `isSidechain` at all — the directory is what makes
//     it a subagent transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  mkTmp, rmrf, runCli, writeClaudeSession, claudeQA, countPairs, writeConfig,
} from './helpers.mjs';

const SESS = '14157c8b-9332-490f-bb5b-bdaf9d6492e1';

function sidechainQA(projectPath, {
  q = 'Instructions for the subagent', a = 'Subagent report',
  ts = '2026-05-27T10:00:00.000Z', uuid = 'sub-u1', sidechain = true,
} = {}) {
  return [
    { type: 'user', uuid, parentUuid: null, timestamp: ts, cwd: projectPath, version: '1.0.0',
      gitBranch: 'main', ...(sidechain ? { isSidechain: true } : {}), message: { role: 'user', content: q } },
    { type: 'assistant', uuid: `a-${uuid}`, parentUuid: uuid, timestamp: ts, cwd: projectPath, version: '1.0.0',
      gitBranch: 'main', ...(sidechain ? { isSidechain: true } : {}),
      message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: a }], usage: { input_tokens: 1, output_tokens: 2 } } },
  ];
}

const INLINE_Q = 'INLINE-SIDECHAIN-QUESTION';
const FILE_Q = 'Instructions for the subagent';

function scaffold() {
  const home = mkTmp('ccx-home-');
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const out = path.join(project, 'CCXLOG');
  // One ordinary pair plus an INLINE subagent conversation in the same log.
  writeClaudeSession(home, project, `${SESS}.jsonl`, [
    ...claudeQA(project),
    ...sidechainQA(project, { q: INLINE_Q, a: 'Inline subagent report', uuid: 'inline-u1' }),
  ]);
  // The separate-file form. Its records DO carry isSidechain here; the
  // no-isSidechain variant is covered by its own test below.
  writeClaudeSession(home, project, path.join(SESS, 'subagents', 'agent-a5b95863.jsonl'), sidechainQA(project));
  writeClaudeSession(home, project, path.join(SESS, 'subagents', 'nested', 'agent-deep.jsonl'),
    sidechainQA(project, { q: 'DEEP-NESTED-MUST-NOT-APPEAR' }));
  writeClaudeSession(home, project, path.join('memory', 'notes.jsonl'), claudeQA(project, { q: 'MEMORY-DIR-MUST-NOT-APPEAR', uuid: 'u-mem' }));
  return { home, project, out, cleanup: () => rmrf(home) };
}

function read(s, name = 'cclog.md') {
  return fs.readFileSync(path.join(s.out, name), 'utf-8');
}

function ids(text) {
  return text.match(/ccxlogid:[0-9a-f]{24}/g) ?? [];
}

test('subagents: the default includes both the inline and the separate-file form', () => {
  const s = scaffold();
  try {
    const r = runCli([s.project, '-cc'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    const text = read(s);
    assert.equal(countPairs(path.join(s.out, 'cclog.md')), 3);   // 1 ordinary + inline + separate file
    assert.match(text, new RegExp(INLINE_Q));
    assert.match(text, /Inline subagent report/);
    assert.match(text, new RegExp(FILE_Q));
    assert.match(text, /Subagent report/);
    // The discovery reach is unchanged: still one level under subagents/ only.
    assert.doesNotMatch(text, /DEEP-NESTED-MUST-NOT-APPEAR/);
    assert.doesNotMatch(text, /MEMORY-DIR-MUST-NOT-APPEAR/);
  } finally { s.cleanup(); }
});

test('subagents: claude.includeSubagents=false excludes both storage forms', () => {
  const s = scaffold();
  try {
    writeConfig(s.out, { claude: { includeSubagents: false } });
    const r = runCli([s.project, '-cc'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    const text = read(s);
    assert.equal(countPairs(path.join(s.out, 'cclog.md')), 1);
    assert.doesNotMatch(text, new RegExp(INLINE_Q));
    assert.doesNotMatch(text, new RegExp(FILE_Q));
    assert.match(text, /Hello Claude/);
  } finally { s.cleanup(); }
});

test('subagents: a separate transcript with no isSidechain flag is still a subagent transcript', () => {
  const home = mkTmp('ccx-home-');
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const out = path.join(project, 'CCXLOG');
  try {
    writeClaudeSession(home, project, `${SESS}.jsonl`, claudeQA(project));
    // Newer Claude Code writes these transcripts WITHOUT the historical flag.
    // Only the directory says what the file is.
    writeClaudeSession(home, project, path.join(SESS, 'subagents', 'agent-plain.jsonl'),
      sidechainQA(project, { q: 'UNFLAGGED-SUBAGENT', sidechain: false }));

    assert.equal(runCli([project, '-cc'], { home }).code, 0);
    assert.match(fs.readFileSync(path.join(out, 'cclog.md'), 'utf-8'), /UNFLAGGED-SUBAGENT/);

    writeConfig(out, { claude: { includeSubagents: false } });
    assert.equal(runCli([project, '-cc'], { home }).code, 0);
    assert.doesNotMatch(fs.readFileSync(path.join(out, 'cclog.md'), 'utf-8'), /UNFLAGGED-SUBAGENT/);
  } finally { rmrf(home); }
});

// The same fixture rendered under each spelling. Comparing two SEPARATE
// workspaces would compare different project paths (%Cwd% renders them), so the
// value is flipped inside one workspace and the resulting bytes are compared.
function bytesUnder(s, config) {
  writeConfig(s.out, config);
  const r = runCli([s.project, '-cc'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  return read(s);
}

test('subagents: the official key and the former name agree byte for byte', () => {
  const s = scaffold();
  try {
    const official = bytesUnder(s, { claude: { includeSubagents: true } });
    const legacy = bytesUnder(s, { claude: { includeSidechain: true } });
    assert.equal(legacy, official);
    assert.equal(countPairs(path.join(s.out, 'cclog.md')), 3);
  } finally { s.cleanup(); }
});

test('subagents: the former name set to false reproduces the previous default output', () => {
  const s = scaffold();
  try {
    const legacy = bytesUnder(s, { claude: { includeSidechain: false } });
    assert.equal(countPairs(path.join(s.out, 'cclog.md')), 1);
    const official = bytesUnder(s, { claude: { includeSubagents: false } });
    assert.equal(official, legacy);
  } finally { s.cleanup(); }
});

test('subagents: per-session mode writes a file with the __subagents__ session id', () => {
  const s = scaffold();
  try {
    const r = runCli([s.project, '-cc', '--per-session'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    const files = fs.readdirSync(s.out).filter(f => f.startsWith('cclog_'));
    const subFile = files.find(f => f.includes('__subagents__agent-a5b95863'));
    assert.ok(subFile, `subagent per-session file not found in: ${files.join(', ')}`);
    assert.match(fs.readFileSync(path.join(s.out, subFile), 'utf-8'), /Subagent report/);
  } finally { s.cleanup(); }
});

// The migration an existing user actually goes through: the previous release
// behaved like includeSubagents=false, and the upgrade must be purely additive.
test('subagents: migrating from the old implicit false adds ids only and creates no backup', () => {
  const s = scaffold();
  try {
    writeConfig(s.out, { claude: { includeSubagents: false } });
    let r = runCli([s.project, '-cc'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    const before = read(s);
    const beforeIds = ids(before);
    assert.equal(beforeIds.length, 1);

    fs.rmSync(path.join(s.out, 'ccxlog.config.json'));   // back to the default (true)
    r = runCli([s.project, '-cc'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Backed up/);
    assert.ok(!fs.existsSync(path.join(s.out, 'backup_CCXLOG_md_auto')), 'no backup dir expected');

    const after = read(s);
    for (const id of beforeIds) assert.ok(after.includes(id), `existing id ${id} must survive`);
    assert.equal(countPairs(path.join(s.out, 'cclog.md')), 3);
    // Additive: every old block survives unchanged, only new ones appear.
    assert.equal(ids(after).filter(id => beforeIds.includes(id)).length, beforeIds.length);
  } finally { s.cleanup(); }
});

// The delegation shape a real Task use produces: the parent's tool_use, the
// delegated conversation, then the parent's own tool_result and answer. Building
// one interleaved stream files that trailing tool_result — and with it the
// parent's answer — under the SIDECHAIN pair, so the ordinary block renders with
// an empty %Answer% the moment subagents are switched on. Measured against the
// v1.7.1 build, which does exactly that.
test('subagents: a delegation does not move the parent answer onto the subagent pair', () => {
  const home = mkTmp('ccx-home-');
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const out = path.join(project, 'CCXLOG');
  const at = (n) => `2026-05-27T11:0${n}:00.000Z`;
  const base = { cwd: project, version: '1.0.0', gitBranch: 'main' };
  try {
    writeClaudeSession(home, project, 's.jsonl', [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: at(0), ...base,
        message: { role: 'user', content: 'MAIN QUESTION' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: at(1), ...base,
        message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 't1', name: 'Task', input: {} }] } },
      { type: 'user', uuid: 's1', parentUuid: null, timestamp: at(2), ...base, isSidechain: true,
        message: { role: 'user', content: 'SIDECHAIN QUESTION' } },
      { type: 'assistant', uuid: 's2', parentUuid: 's1', timestamp: at(3), ...base, isSidechain: true,
        message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'SIDECHAIN ANSWER' }] } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: at(4), ...base,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'TASK RESULT' }] } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: at(5), ...base,
        message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'MAIN ANSWER' }] } },
    ]);

    writeConfig(out, { claude: { includeSubagents: false } });
    assert.equal(runCli([project, '-cc'], { home }).code, 0);
    const hidden = fs.readFileSync(path.join(out, 'cclog.md'), 'utf-8');

    writeConfig(out, { claude: { includeSubagents: true } });
    assert.equal(runCli([project, '-cc'], { home }).code, 0);
    const shown = fs.readFileSync(path.join(out, 'cclog.md'), 'utf-8');

    const mainBlock = (text) => text.split(/(?=<!-- ccxlogid:)/).find(b => b.includes('MAIN QUESTION'));
    // The ordinary block is byte-identical with subagents on and off.
    assert.equal(mainBlock(shown), mainBlock(hidden));
    assert.match(mainBlock(shown), /MAIN ANSWER/);
    assert.match(shown, /SIDECHAIN QUESTION/);
    assert.equal(countPairs(path.join(out, 'cclog.md')), 2);
  } finally { rmrf(home); }
});

// An inline subagent question recorded in the very same millisecond as an
// ordinary one used to join its collision group and shift its ordinal, which
// moves the ordinary block's ccxlogid. Enabling subagents may not move a single
// existing id (spec §5.2 / §13).
test('subagents: an inline subagent sharing a timestamp does not move the ordinary block id', () => {
  const home = mkTmp('ccx-home-');
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const out = path.join(project, 'CCXLOG');
  const TS = '2026-05-27T11:03:49.000Z';
  try {
    writeClaudeSession(home, project, `${SESS}.jsonl`, [
      // uuid 'zz-main' sorts AFTER the sidechain uuid 'aa-sub', so a shared
      // group would push the ordinary pair from ordinal 0 to ordinal 1.
      ...claudeQA(project, { ts: TS, uuid: 'zz-main' }),
      ...sidechainQA(project, { q: 'SAME-MS-SUBAGENT', ts: TS, uuid: 'aa-sub' }),
    ]);

    writeConfig(out, { claude: { includeSubagents: false } });
    assert.equal(runCli([project, '-cc'], { home }).code, 0);
    const beforeIds = ids(fs.readFileSync(path.join(out, 'cclog.md'), 'utf-8'));
    assert.equal(beforeIds.length, 1);

    writeConfig(out, { claude: { includeSubagents: true } });
    assert.equal(runCli([project, '-cc'], { home }).code, 0);
    const after = fs.readFileSync(path.join(out, 'cclog.md'), 'utf-8');
    assert.equal(countPairs(path.join(out, 'cclog.md')), 2);
    assert.ok(after.includes(beforeIds[0]), 'the ordinary block must keep its id');
  } finally { rmrf(home); }
});
