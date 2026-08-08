// Acceptance tests for the shared subagent display option (spec §15).
//
// §15.2 (the Claude-specific storage forms) lives in subagents.test.mjs; this
// file covers configuration (§15.1), Codex (§15.3), the intentional zero-pair
// outcome together with backups and ids (§15.4), per-session safety (§15.5) and
// watch / cache behaviour (§15.6).
//
// The Codex record shapes are the ones taken from real ~/.codex/sessions
// rollouts — see the header of codexInheritedHistory.test.mjs for why inventing
// friendlier shapes makes a subagent feature pass its tests and never fire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../dist/lib/config.js';
import {
  mkTmp, rmrf, runCli, writeCodexSession, writeClaudeSession, claudeQA,
  countPairs, writeConfig,
} from './helpers.mjs';

const watchTest = process.env.CCXLOG_SKIP_WATCH_TESTS === '1'
  ? (name, fn) => test(name, { skip: 'Run with npm run test:watch' }, fn)
  : test;

// ---------------------------------------------------------------------------
// §15.1 configuration
// ---------------------------------------------------------------------------

async function withConfig(obj, fn) {
  const dir = mkTmp('ccx-subcfg-');
  try {
    if (obj !== null) {
      fs.writeFileSync(path.join(dir, 'ccxlog.config.json'),
        typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf-8');
    }
    return await fn(dir);
  } finally { rmrf(dir); }
}

test('cfg 1: both official settings default to true', async () => {
  await withConfig(null, async (dir) => {
    const { config, errors } = await loadConfig(dir, dir);
    assert.equal(errors.length, 0);
    assert.equal(config.claude.includeSubagents, true);
    assert.equal(config.codex.includeSubagents, true);
  });
});

test('cfg 2: both official settings accept true and false', async () => {
  for (const value of [true, false]) {
    await withConfig({ claude: { includeSubagents: value }, codex: { includeSubagents: value } }, async (dir) => {
      const { config, errors, warnings } = await loadConfig(dir, dir);
      assert.equal(errors.length, 0, errors.join('; '));
      assert.equal(warnings.length, 0, warnings.join('; '));
      assert.equal(config.claude.includeSubagents, value);
      assert.equal(config.codex.includeSubagents, value);
    });
  }
});

test('cfg 3: the former Claude name alone reproduces both behaviours', async () => {
  for (const value of [true, false]) {
    await withConfig({ claude: { includeSidechain: value } }, async (dir) => {
      const { config, errors, warnings } = await loadConfig(dir, dir);
      assert.equal(errors.length, 0, errors.join('; '));
      assert.equal(warnings.length, 0, warnings.join('; '));
      assert.equal(config.claude.includeSubagents, value);
    });
  }
});

test('cfg 4: the official name and the former name agreeing is accepted', async () => {
  for (const value of [true, false]) {
    await withConfig({ claude: { includeSubagents: value, includeSidechain: value } }, async (dir) => {
      const { config, errors } = await loadConfig(dir, dir);
      assert.equal(errors.length, 0, errors.join('; '));
      assert.equal(config.claude.includeSubagents, value);
    });
  }
});

test('cfg 5: the two Claude names disagreeing is a fatal config error', async () => {
  await withConfig({ claude: { includeSubagents: true, includeSidechain: false } }, async (dir) => {
    const { errors } = await loadConfig(dir, dir);
    assert.ok(errors.some(e => /includeSubagents.*includeSidechain.*different values/i.test(e)),
      `expected a conflict error, got: ${errors.join('; ')}`);
  });
});

// "Before any side effect" is the point of §5.2 rule 4: the run must not have
// written, backed up or deleted anything by the time the conflict is reported.
test('cfg 6: the conflict aborts the run before it writes anything', () => {
  const home = mkTmp('ccx-conflict-');
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const out = path.join(project, 'CCXLOG');
  try {
    writeClaudeSession(home, project, 'a.jsonl', claudeQA(project));
    writeConfig(out, { claude: { includeSubagents: false, includeSidechain: true } });
    const r = runCli([project, '-cc'], { home });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Config error:.*different values/i);
    assert.equal(fs.existsSync(path.join(out, 'cclog.md')), false);
  } finally { rmrf(home); }
});

test('cfg 7: a non-boolean value warns and resolves as unspecified', async () => {
  // The official key is unusable, so the former name decides — rather than the
  // bad value silently winning or the pair being called a conflict.
  await withConfig({ claude: { includeSubagents: 'yes', includeSidechain: false } }, async (dir) => {
    const { config, errors, warnings } = await loadConfig(dir, dir);
    assert.equal(errors.length, 0, errors.join('; '));
    assert.ok(warnings.some(w => /claude\.includeSubagents.*must be a boolean/i.test(w)));
    assert.equal(config.claude.includeSubagents, false);
  });
  // With nothing usable left, the default applies.
  await withConfig({ codex: { includeSubagents: 1 } }, async (dir) => {
    const { config, warnings } = await loadConfig(dir, dir);
    assert.ok(warnings.some(w => /codex\.includeSubagents.*must be a boolean/i.test(w)));
    assert.equal(config.codex.includeSubagents, true);
  });
});

test('cfg 8: codex.includeSidechain is an unknown key, not an alias', async () => {
  await withConfig({ codex: { includeSidechain: false } }, async (dir) => {
    const { config, warnings } = await loadConfig(dir, dir);
    assert.ok(warnings.some(w => /unknown "codex\.includeSidechain"/.test(w)));
    assert.equal(config.codex.includeSubagents, true);
  });
});

test('cfg 9: the two sources are independent', async () => {
  await withConfig({ claude: { includeSubagents: false }, codex: { includeSubagents: true } }, async (dir) => {
    const { config, errors } = await loadConfig(dir, dir);
    assert.equal(errors.length, 0, errors.join('; '));
    assert.equal(config.claude.includeSubagents, false);
    assert.equal(config.codex.includeSubagents, true);
  });
});

// ---------------------------------------------------------------------------
// Codex rollout fixtures (real record shapes)
// ---------------------------------------------------------------------------

const PARENT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const GRAND_ID = '33333333-3333-4333-8333-333333333333';
const FORK_ID = '44444444-4444-4444-8444-444444444444';

const PARENT_TS = '2026-05-27T10:00:00.000Z';
const CHILD_TS = '2026-05-27T12:00:00.000Z';
const GRAND_TS = '2026-05-27T13:00:00.000Z';
const FORK_TS = '2026-05-27T14:00:00.000Z';

const ENCRYPTED = 'gAAAAABqcYvqSHORTENED_FOR_THE_FIXTURE';

function rootMeta(cwd, ts = PARENT_TS, id = PARENT_ID, extra = {}) {
  return {
    timestamp: ts, type: 'session_meta',
    payload: {
      id, session_id: id, cwd, cli_version: '0.144.6',
      git: { branch: 'parent-branch' }, session_name: 'parent session', ...extra,
    },
  };
}

function subagentMeta(cwd, { id, sessionId = PARENT_ID, parentThreadId = PARENT_ID, ts, nickname }) {
  const names = { agent_path: `.codex/agents/${nickname}.md`, agent_nickname: nickname };
  return {
    timestamp: ts, type: 'session_meta',
    payload: {
      id, session_id: sessionId, parent_thread_id: parentThreadId,
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: names } },
      ...names,
      forked_from_id: sessionId,
      cwd, cli_version: '0.146.0', git: { branch: 'child-branch' },
    },
  };
}

function turn(turnId, ts, cwd) {
  return [
    { timestamp: ts, type: 'turn_context', payload: { turn_id: turnId, cwd, model: 'gpt-5' } },
    { timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
  ];
}

const userMsg = (ts, message) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message } });
const agentMsg = (ts, message) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'agent_message', message } });
const taskComplete = (ts, answer) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: answer } });
const marker = (ts) => ({ timestamp: ts, type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } });

function instruction(ts, text, turnId) {
  return {
    timestamp: ts, type: 'response_item',
    payload: {
      type: 'agent_message', id: `amsg_${turnId}`, author: '/root', recipient: '/root/r1_review',
      content: [{ type: 'input_text', text }, { type: 'encrypted_content', encrypted_content: ENCRYPTED }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  };
}

// The parent conversation, re-stampable: a child rollout re-records these very
// records with its own start time. `answerLastTurn` is what the parent's own
// rollout lacks and only the child's copy holds.
function parentHistory(ts, cwd, { answerLastTurn = false, lastAnswer = 'Parent answer two' } = {}) {
  return [
    ...turn('turn-1', ts, cwd),
    userMsg(ts, 'Parent question one'),
    agentMsg(ts, 'Parent answer one'),
    taskComplete(ts, 'Parent answer one'),
    ...turn('turn-2', ts, cwd),
    userMsg(ts, 'Parent question two'),
    ...(answerLastTurn ? [agentMsg(ts, lastAnswer), taskComplete(ts, lastAnswer)] : []),
  ];
}

const CHILD_TASK = 'Message Type: NEW_TASK\nTask name: /root/r1_review\nSender: /root\nPayload:\nReview the diff';
const GRAND_TASK = 'Message Type: NEW_TASK\nTask name: /root/r1_review/r2\nSender: /root/r1_review\nPayload:\nGRANDCHILD-TASK';

function ownTurns(cwd, ts, task, answer, turnId) {
  return [marker(ts), instruction(ts, task, turnId), ...turn(turnId, ts, cwd), agentMsg(ts, answer), taskComplete(ts, answer)];
}

function scaffold(t, prefix = 'ccx-subopt-') {
  const home = mkTmp(prefix);
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const out = path.join(project, 'CCXLOG');
  if (t) t.after(() => rmrf(home));
  return { home, project, out };
}

// A parent, its child, the child's own child, and an ordinary fork that carries
// forked_from_id but is NOT a subagent.
function writeCodexFamily(s, { childLastAnswer = 'Parent answer two', parentLastAnswer = null } = {}) {
  writeCodexSession(s.home, `rollout-2026-05-27T10-00-00-${PARENT_ID}.jsonl`, [
    rootMeta(s.project),
    // Without `parentLastAnswer` the parent's rollout stops after its second
    // question and only the child's re-recording holds the answer.
    ...parentHistory(PARENT_TS, s.project, parentLastAnswer
      ? { answerLastTurn: true, lastAnswer: parentLastAnswer }
      : {}),
  ]);
  writeCodexSession(s.home, `rollout-2026-05-27T12-00-00-${CHILD_ID}.jsonl`, [
    subagentMeta(s.project, { id: CHILD_ID, ts: CHILD_TS, nickname: 'reviewer' }),
    rootMeta(s.project, CHILD_TS),
    ...parentHistory(CHILD_TS, s.project, { answerLastTurn: true, lastAnswer: childLastAnswer }),
    ...ownTurns(s.project, CHILD_TS, CHILD_TASK, 'Child answer to NEW_TASK', 'turn-child-1'),
  ]);
  writeCodexSession(s.home, `rollout-2026-05-27T13-00-00-${GRAND_ID}.jsonl`, [
    subagentMeta(s.project, { id: GRAND_ID, sessionId: PARENT_ID, parentThreadId: CHILD_ID, ts: GRAND_TS, nickname: 'deep' }),
    ...ownTurns(s.project, GRAND_TS, GRAND_TASK, 'Grandchild answer', 'turn-grand-1'),
  ]);
  // An ordinary fork/resume: forked_from_id is present, thread_source and
  // source.subagent are not. It must never be treated as a subagent.
  writeCodexSession(s.home, `rollout-2026-05-27T14-00-00-${FORK_ID}.jsonl`, [
    rootMeta(s.project, FORK_TS, FORK_ID, { forked_from_id: PARENT_ID }),
    ...turn('turn-fork-1', FORK_TS, s.project),
    userMsg(FORK_TS, 'FORKED-SESSION-QUESTION'),
    agentMsg(FORK_TS, 'Forked answer'),
    taskComplete(FORK_TS, 'Forked answer'),
  ]);
}

const readOut = (s, name = 'cxlog.md') => fs.readFileSync(path.join(s.out, name), 'utf-8');
const ids = (text) => text.match(/ccxlogid:[0-9a-f]{24}/g) ?? [];

// ---------------------------------------------------------------------------
// §15.3 Codex
// ---------------------------------------------------------------------------

test('cx 1: the default renders subagents exactly as the always-on behaviour did', (t) => {
  const s = scaffold(t);
  writeCodexFamily(s);

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const byDefault = readOut(s);
  // An explicit true must be indistinguishable from the default.
  writeConfig(s.out, { codex: { includeSubagents: true } });
  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  assert.equal(readOut(s), byDefault);

  assert.match(byDefault, /Message Type: NEW_TASK/);
  assert.match(byDefault, /Child answer to NEW_TASK/);
  assert.match(byDefault, /GRANDCHILD-TASK/);
  assert.match(byDefault, /Grandchild answer/);
  assert.match(byDefault, /FORKED-SESSION-QUESTION/);
});

test('cx 2: false hides the real instructions and replies, children and grandchildren alike', (t) => {
  const s = scaffold(t);
  writeCodexFamily(s);
  writeConfig(s.out, { codex: { includeSubagents: false } });

  const r = runCli([s.project, '-cx'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const text = readOut(s);
  assert.doesNotMatch(text, /Message Type: NEW_TASK/);
  assert.doesNotMatch(text, /Child answer to NEW_TASK/);
  assert.doesNotMatch(text, /GRANDCHILD-TASK/);
  assert.doesNotMatch(text, /Grandchild answer/);
  // Normal sessions, forks and resumes stay: forked_from_id alone is not a
  // subagent, and the parent is not one at all.
  assert.match(text, /FORKED-SESSION-QUESTION/);
  assert.match(text, /Parent question one/);
  assert.match(text, /Parent question two/);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 3);
});

test('cx 3: inherited history is matched BEFORE the children are hidden', (t) => {
  const s = scaffold(t);
  // The parent's rollout stops after its second question; only the child's
  // re-recording holds the answer. Hiding the child first would lose it.
  writeCodexFamily(s);
  writeConfig(s.out, { codex: { includeSubagents: false } });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  const block = text.split(/(?=<!-- ccxlogid:)/).find(b => b.includes('Parent question two'));
  assert.ok(block, 'the parent question must still be rendered');
  assert.match(block, /Parent answer two/);
});

test('cx 4: a conflicting copy is hidden only by an explicit false, and is not reported as kept', (t) => {
  const s = scaffold(t);
  // Both copies of the parent's second turn end on an answer, and the two
  // answers differ. There is no safe way to show both in one block, so the
  // child's copy is KEPT rather than silently dropped — under true.
  writeCodexFamily(s, {
    parentLastAnswer: 'Parent answer two',
    childLastAnswer: 'IRRECONCILABLE-CHILD-ANSWER',
  });

  let r = runCli([s.project, '-cx', '--verbose'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(readOut(s), /IRRECONCILABLE-CHILD-ANSWER/);
  assert.match(r.stdout, /kept 1 the original could not absorb/);

  writeConfig(s.out, { codex: { includeSubagents: false } });
  r = runCli([s.project, '-cx', '--verbose'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(readOut(s), /IRRECONCILABLE-CHILD-ANSWER/);
  // Announcing it as "kept" would send the reader looking for a block that the
  // display filter removed a step later.
  assert.doesNotMatch(r.stdout, /could not absorb/);
  assert.match(r.stdout, /Hidden by includeSubagents: 0 claude pair\(s\), \d+ codex pair\(s\)/);
});

test('cx 5: --backup-jsonl copies subagent rollouts whatever the display setting says', (t) => {
  const s = scaffold(t);
  writeCodexFamily(s);
  const listing = (dir) => {
    const found = [];
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
        else found.push(`${rel}${e.name}`);
      }
    };
    walk(dir, '');
    return found.sort();
  };

  writeConfig(s.out, { codex: { includeSubagents: false } });
  assert.equal(runCli([s.project, '-cx', '--backup-jsonl'], { home: s.home }).code, 0);
  const hiddenRoot = path.join(s.out, 'backup_jsonl');
  const hiddenFiles = listing(hiddenRoot);
  assert.ok(hiddenFiles.some(f => f.includes(CHILD_ID)), `child rollout missing: ${hiddenFiles.join(', ')}`);
  assert.ok(hiddenFiles.some(f => f.includes(GRAND_ID)), `grandchild rollout missing: ${hiddenFiles.join(', ')}`);

  // The same run with subagents shown must copy exactly the same set.
  rmrf(hiddenRoot);
  writeConfig(s.out, { codex: { includeSubagents: true } });
  assert.equal(runCli([s.project, '-cx', '--backup-jsonl'], { home: s.home }).code, 0);
  const shownFiles = listing(hiddenRoot);
  assert.deepEqual(
    shownFiles.map(f => f.replace(/^[^/]+\//, '')),
    hiddenFiles.map(f => f.replace(/^[^/]+\//, '')),
    'the raw-log backup must not depend on the display setting',
  );
});

test('cx 6: hiding Claude subagents leaves Codex subagents alone', (t) => {
  const s = scaffold(t);
  writeCodexFamily(s);
  writeClaudeSession(s.home, s.project, 'cc1.jsonl', [
    ...claudeQA(s.project),
    { type: 'user', uuid: 'cc-sub', parentUuid: null, timestamp: '2026-05-27T11:30:00.000Z', cwd: s.project,
      version: '1.0.0', gitBranch: 'main', isSidechain: true, message: { role: 'user', content: 'CLAUDE-SUBAGENT-Q' } },
    { type: 'assistant', uuid: 'cc-sub-a', parentUuid: 'cc-sub', timestamp: '2026-05-27T11:30:00.000Z', cwd: s.project,
      version: '1.0.0', gitBranch: 'main', isSidechain: true,
      message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'CLAUDE-SUBAGENT-A' }] } },
  ]);
  writeConfig(s.out, { claude: { includeSubagents: false }, codex: { includeSubagents: true } });

  assert.equal(runCli([s.project], { home: s.home }).code, 0);
  const text = readOut(s, 'ccxlog.md');
  assert.doesNotMatch(text, /CLAUDE-SUBAGENT-Q/);
  assert.match(text, /Message Type: NEW_TASK/);
  assert.match(text, /Hello Claude/);
});

// ---------------------------------------------------------------------------
// §15.4 zero pairs, backups, ids
// ---------------------------------------------------------------------------

// A project whose only Claude log is a subagent transcript: hiding subagents
// leaves nothing to show, and that is a success, not a failure.
function onlyChildrenScaffold(t) {
  const s = scaffold(t, 'ccx-onlykids-');
  const SESS = '14157c8b-9332-490f-bb5b-bdaf9d6492e1';
  writeClaudeSession(s.home, s.project, path.join(SESS, 'subagents', 'agent-a1.jsonl'), [
    { type: 'user', uuid: 'sub-u1', parentUuid: null, timestamp: '2026-05-27T10:00:00.000Z', cwd: s.project,
      version: '1.0.0', gitBranch: 'main', isSidechain: true, message: { role: 'user', content: 'ONLY-CHILD-Q' } },
    { type: 'assistant', uuid: 'sub-a1', parentUuid: 'sub-u1', timestamp: '2026-05-27T10:00:00.000Z', cwd: s.project,
      version: '1.0.0', gitBranch: 'main', isSidechain: true,
      message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ONLY-CHILD-A' }] } },
  ]);
  return s;
}

test('zero 1: a children-only project converges to a 0-pair file, exactly one backup, then noop', (t) => {
  const s = onlyChildrenScaffold(t);
  const file = path.join(s.out, 'cclog.md');
  const autoDir = path.join(s.out, 'backup_CCXLOG_md_auto');

  // Default (true): one block.
  assert.equal(runCli([s.project, '-cc'], { home: s.home }).code, 0);
  assert.equal(countPairs(file), 1);
  const originalId = ids(readOut(s, 'cclog.md'))[0];

  // true -> false: the id disappears, so exactly one automatic backup is taken.
  writeConfig(s.out, { claude: { includeSubagents: false } });
  let r = runCli([s.project, '-cc'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Done\. 0 pair\(s\) total/);
  assert.equal(countPairs(file), 0);
  const text = readOut(s, 'cclog.md');
  assert.match(text, /^<!-- ccxlog-owner:ccxlog; kind:aggregate; mode:claude -->/);
  assert.doesNotMatch(text, /ONLY-CHILD-Q/);
  const backups = fs.readdirSync(autoDir);
  assert.equal(backups.length, 1, `expected exactly one backup folder, got ${backups.join(', ')}`);
  assert.match(fs.readFileSync(path.join(autoDir, backups[0], 'cclog.md'), 'utf-8'), /ONLY-CHILD-Q/);

  // The second run over the same input is a complete noop.
  r = runCli([s.project, '-cc'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\[noop\]/);
  assert.deepEqual(fs.readdirSync(autoDir), backups);

  // false -> true restores the block under the very same id.
  //
  // This degenerate project — every log is a subagent transcript — is the one
  // place where the return trip DOES take a backup: the 0-pair document holds no
  // ccxlogid at all, so the id-loss check has nothing to compare and falls to
  // its "undecidable, copy first" branch. Spec §9.2 keeps that existing check as
  // the authority, so it is left exactly as it was rather than taught a special
  // case (the general false -> true migration, where ordinary blocks survive
  // alongside, takes no backup — see "migrating from the old implicit false" in
  // subagents.test.mjs and "id 1" below).
  writeConfig(s.out, { claude: { includeSubagents: true } });
  r = runCli([s.project, '-cc'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(countPairs(file), 1);
  assert.equal(ids(readOut(s, 'cclog.md'))[0], originalId, 'the restored block keeps its original id');
});

test('id 1: turning subagents back on adds ids without taking a backup', (t) => {
  const s = scaffold(t, 'ccx-idadd-');
  writeCodexFamily(s);
  const autoDir = path.join(s.out, 'backup_CCXLOG_md_auto');

  writeConfig(s.out, { codex: { includeSubagents: false } });
  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const hiddenIds = ids(readOut(s));
  assert.equal(hiddenIds.length, 3);
  assert.equal(fs.existsSync(autoDir), false);

  writeConfig(s.out, { codex: { includeSubagents: true } });
  const r = runCli([s.project, '-cx'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Backed up/);
  assert.equal(fs.existsSync(autoDir), false, 'adding blocks must not create a backup');
  const shownIds = ids(readOut(s));
  assert.ok(shownIds.length > hiddenIds.length);
  for (const id of hiddenIds) assert.ok(shownIds.includes(id), `id ${id} must survive`);
});

test('zero 2: surviving parent ids are untouched when children are hidden', (t) => {
  const s = scaffold(t);
  writeCodexFamily(s);

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const shownText = readOut(s);
  const parentBlockIds = shownText.split(/(?=<!-- ccxlogid:)/)
    .filter(b => /Parent question (one|two)|FORKED-SESSION-QUESTION/.test(b))
    .map(b => ids(b)[0]);
  assert.equal(parentBlockIds.length, 3);

  writeConfig(s.out, { codex: { includeSubagents: false } });
  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const hiddenText = readOut(s);
  for (const id of parentBlockIds) assert.ok(hiddenText.includes(id), `surviving id ${id} must not move`);
});

test('zero 3: genuinely absent data is still a runtime error that keeps the old output', (t) => {
  const s = onlyChildrenScaffold(t);
  const file = path.join(s.out, 'cclog.md');
  assert.equal(runCli([s.project, '-cc'], { home: s.home }).code, 0);
  const before = fs.readFileSync(file, 'utf-8');

  // Remove the logs entirely: now there is nothing to hide and nothing to show.
  rmrf(path.join(s.home, '.claude'));
  const r = runCli([s.project, '-cc'], { home: s.home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /No pairs found/);
  assert.equal(fs.readFileSync(file, 'utf-8'), before, 'the existing output must be left alone');
});

// ---------------------------------------------------------------------------
// §15.5 per-session and safety
// ---------------------------------------------------------------------------

function mixedPerSessionScaffold(t) {
  const s = scaffold(t, 'ccx-persess-');
  const SESS = '14157c8b-9332-490f-bb5b-bdaf9d6492e1';
  writeClaudeSession(s.home, s.project, `${SESS}.jsonl`, claudeQA(s.project));
  writeClaudeSession(s.home, s.project, path.join(SESS, 'subagents', 'agent-a1.jsonl'), [
    { type: 'user', uuid: 'sub-u1', parentUuid: null, timestamp: '2026-05-27T10:00:00.000Z', cwd: s.project,
      version: '1.0.0', gitBranch: 'main', isSidechain: true, message: { role: 'user', content: 'CC-CHILD-Q' } },
    { type: 'assistant', uuid: 'sub-a1', parentUuid: 'sub-u1', timestamp: '2026-05-27T10:00:00.000Z', cwd: s.project,
      version: '1.0.0', gitBranch: 'main', isSidechain: true,
      message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'CC-CHILD-A' }] } },
  ]);
  writeCodexFamily(s);
  return s;
}

const sessionFiles = (dir) => fs.readdirSync(dir).filter(f => /^(cclog|cxlog)_.+\.md$/.test(f)).sort();

test('ps 1: aggregate and per-session agree on the pair set with subagents hidden', (t) => {
  const s = mixedPerSessionScaffold(t);
  writeConfig(s.out, { claude: { includeSubagents: false }, codex: { includeSubagents: false } });

  let r = runCli([s.project], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const aggregate = countPairs(path.join(s.out, 'ccxlog.md'));

  r = runCli([s.project, '--per-session'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  const perSession = sessionFiles(s.out)
    .reduce((n, f) => n + countPairs(path.join(s.out, f)), 0);
  assert.equal(perSession, aggregate);
  assert.ok(aggregate > 0);
});

test('ps 2: hiding removes the child session files of BOTH sources after a verified backup', (t) => {
  const s = mixedPerSessionScaffold(t);

  assert.equal(runCli([s.project, '--per-session'], { home: s.home }).code, 0);
  const shown = sessionFiles(s.out);
  const ccChild = shown.find(f => f.includes('__subagents__agent-a1'));
  const cxChild = shown.find(f => f.includes(CHILD_ID));
  const cxGrand = shown.find(f => f.includes(GRAND_ID));
  assert.ok(ccChild && cxChild && cxGrand, `expected child files, got: ${shown.join(', ')}`);
  const childBodies = [ccChild, cxChild, cxGrand]
    .map(f => [f, fs.readFileSync(path.join(s.out, f), 'utf-8')]);

  writeConfig(s.out, { claude: { includeSubagents: false }, codex: { includeSubagents: false } });
  const r = runCli([s.project, '--per-session'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);

  const after = sessionFiles(s.out);
  for (const [name] of childBodies) assert.ok(!after.includes(name), `${name} must be removed`);
  assert.ok(after.some(f => f.includes(PARENT_ID)), 'the parent session file must stay');

  // Every removed file was copied out first, byte for byte.
  const autoDir = path.join(s.out, 'backup_CCXLOG_md_auto');
  const stamp = path.join(autoDir, fs.readdirSync(autoDir)[0]);
  for (const [name, body] of childBodies) {
    assert.equal(fs.readFileSync(path.join(stamp, name), 'utf-8'), body, `${name} must be backed up verbatim`);
  }

  // Restoring the setting regenerates them from the raw logs.
  writeConfig(s.out, { claude: { includeSubagents: true }, codex: { includeSubagents: true } });
  assert.equal(runCli([s.project, '--per-session'], { home: s.home }).code, 0);
  const restored = sessionFiles(s.out);
  for (const [name] of childBodies) assert.ok(restored.includes(name), `${name} must come back`);
});

test('ps 3: files that cannot be proven to belong to a discovered child are kept', (t) => {
  const s = mixedPerSessionScaffold(t);
  assert.equal(runCli([s.project, '--per-session'], { home: s.home }).code, 0);

  // Three files this run must not touch: no owner marker at all, a marker for a
  // session outside this run, and a corrupted marker.
  const strangers = {
    'cclog_no_marker.md': '# Some notes\n\nnothing to do with ccxlog\n',
    'cclog_out_of_scope.md': '<!-- ccxlog-owner:ccxlog; kind:session; source:claude; sid64:'
      + Buffer.from('a-session-this-run-never-saw', 'utf-8').toString('base64url') + ' -->\n# CCXLog\n',
    'cxlog_bad_marker.md': '<!-- ccxlog-owner:ccxlog; kind:session; source:codex; sid64:!!!not-base64!!! -->\n# CCXLog\n',
  };
  for (const [name, body] of Object.entries(strangers)) {
    fs.writeFileSync(path.join(s.out, name), body, 'utf-8');
  }

  writeConfig(s.out, { claude: { includeSubagents: false }, codex: { includeSubagents: false } });
  assert.equal(runCli([s.project, '--per-session'], { home: s.home }).code, 0);
  for (const [name, body] of Object.entries(strangers)) {
    assert.equal(fs.readFileSync(path.join(s.out, name), 'utf-8'), body, `${name} must be left alone`);
  }
});

test('ps 4: a failing backup aborts before any write or delete', (t) => {
  const s = mixedPerSessionScaffold(t);
  assert.equal(runCli([s.project, '--per-session'], { home: s.home }).code, 0);
  const before = Object.fromEntries(sessionFiles(s.out)
    .map(f => [f, fs.readFileSync(path.join(s.out, f), 'utf-8')]));

  // A plain FILE where the automatic backup directory must go: mkdir fails, so
  // no backup can be verified.
  fs.writeFileSync(path.join(s.out, 'backup_CCXLOG_md_auto'), 'not a directory', 'utf-8');
  writeConfig(s.out, { claude: { includeSubagents: false }, codex: { includeSubagents: false } });

  const r = runCli([s.project, '--per-session'], { home: s.home });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /backup failed for .*; not writing anything\./);
  for (const [name, body] of Object.entries(before)) {
    assert.equal(fs.readFileSync(path.join(s.out, name), 'utf-8'), body, `${name} must be untouched`);
  }
});

// A Codex subagent used to be filed under its PARENT's id. Hiding subagents
// must still converge that superseded name, and must still refuse to touch it
// unless the file itself proves it was generated from this child's rollout.
test('ps 4b: a superseded Codex child filename converges even with subagents hidden', (t) => {
  const s = scaffold(t, 'ccx-legacy-');
  writeCodexFamily(s);
  assert.equal(runCli([s.project, '-cx', '--per-session'], { home: s.home }).code, 0);

  // Forge the old-naming leftover: the parent's id in the name and marker, but
  // generated FROM the child's log.
  const legacy = path.join(s.out, `cxlog_${PARENT_ID}.md`);
  const childLog = path.join(s.home, '.codex', 'sessions', '2026', '05', '27',
    `rollout-2026-05-27T12-00-00-${CHILD_ID}.jsonl`);
  fs.writeFileSync(legacy,
    fs.readFileSync(legacy, 'utf-8').replace(/^- Source: .*$/m, `- Source: ${childLog}`), 'utf-8');
  // The parent rollout leaves the project, so nothing claims that name any more.
  fs.rmSync(path.join(s.home, '.codex', 'sessions', '2026', '05', '27',
    `rollout-2026-05-27T10-00-00-${PARENT_ID}.jsonl`));

  writeConfig(s.out, { codex: { includeSubagents: false } });
  const r = runCli([s.project, '-cx', '--per-session'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(legacy), 'the superseded name must go');
  assert.match(r.stdout, /superseded name/);
  const backupRoot = path.join(s.out, 'backup_CCXLOG_md_auto');
  const copies = fs.readdirSync(backupRoot).flatMap(d => fs.readdirSync(path.join(backupRoot, d)));
  assert.ok(copies.includes(`cxlog_${PARENT_ID}.md`), 'the removed file must be backed up first');
});

test('ps 5: --dry-run reports the plan and changes nothing', (t) => {
  const s = mixedPerSessionScaffold(t);
  assert.equal(runCli([s.project, '--per-session'], { home: s.home }).code, 0);
  const before = Object.fromEntries(sessionFiles(s.out)
    .map(f => [f, fs.readFileSync(path.join(s.out, f), 'utf-8')]));

  writeConfig(s.out, { claude: { includeSubagents: false }, codex: { includeSubagents: false } });
  const r = runCli([s.project, '--per-session', '--dry-run'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /would remove file/);
  assert.deepEqual(sessionFiles(s.out).sort(), Object.keys(before).sort());
  for (const [name, body] of Object.entries(before)) {
    assert.equal(fs.readFileSync(path.join(s.out, name), 'utf-8'), body);
  }
  assert.equal(fs.existsSync(path.join(s.out, 'backup_CCXLOG_md_auto')), false);
});

// ---------------------------------------------------------------------------
// §15.6 watch and cache
// ---------------------------------------------------------------------------

watchTest('watch 1: a changed setting is applied on the next cycle and then settles to noop', (t) => {
  const s = scaffold(t, 'ccx-subwatch-');
  writeCodexFamily(s);
  const watchOut = path.join(s.home, 'watch-out');

  writeConfig(watchOut, { watchIntervalSeconds: 1, codex: { includeSubagents: true } });
  let r = runCli([s.project, '-cx', '--out', watchOut, '--watch=2s'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /writes: 1 create, 0 append, 0 rewrite/);
  assert.match(fs.readFileSync(path.join(watchOut, 'cxlog.md'), 'utf-8'), /Message Type: NEW_TASK/);

  // true -> false: exactly one rewrite across the whole run, every later cycle
  // a noop over the unchanged input.
  writeConfig(watchOut, { watchIntervalSeconds: 1, codex: { includeSubagents: false } });
  r = runCli([s.project, '-cx', '--out', watchOut, '--watch=3s'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /writes: 0 create, 0 append, 1 rewrite/);
  assert.doesNotMatch(fs.readFileSync(path.join(watchOut, 'cxlog.md'), 'utf-8'), /Message Type: NEW_TASK/);

  // false -> true restores the child blocks, again exactly once.
  writeConfig(watchOut, { watchIntervalSeconds: 1, codex: { includeSubagents: true } });
  r = runCli([s.project, '-cx', '--out', watchOut, '--watch=3s'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /writes: 0 create, 0 append, 1 rewrite/);
  assert.match(fs.readFileSync(path.join(watchOut, 'cxlog.md'), 'utf-8'), /Message Type: NEW_TASK/);
});

watchTest('watch 2: with subagents hidden, cached and uncached cycles produce the same bytes', (t) => {
  const s = scaffold(t, 'ccx-subwatch2-');
  writeCodexFamily(s);
  writeConfig(s.out, { codex: { includeSubagents: false } });
  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const single = readOut(s);

  const watchOut = path.join(s.home, 'watch-out');
  writeConfig(watchOut, { watchIntervalSeconds: 1, codex: { includeSubagents: false } });
  const r = runCli([s.project, '-cx', '--out', watchOut, '--watch=3s'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);
  // Cycle 1 is a cold parse; every later cycle serves the hidden subagent
  // sessions from the cache and must land on exactly the same bytes.
  assert.equal(fs.readFileSync(path.join(watchOut, 'cxlog.md'), 'utf-8'), single);
  assert.match(r.stdout, /writes: 1 create, 0 append, 0 rewrite/);
});

watchTest('watch 3: a hidden subagent session stays in the cache, so its merge keeps working', (t) => {
  const s = scaffold(t, 'ccx-subwatch3-');
  // The parent's own rollout stops before answering; only the child's
  // re-recording holds "Parent answer two". Hiding the child must still leave
  // that answer on the parent's block — which only works while the child's
  // parsed session is retained.
  writeCodexFamily(s);
  const watchOut = path.join(s.home, 'watch-out');
  writeConfig(watchOut, { watchIntervalSeconds: 1, codex: { includeSubagents: false } });

  const r = runCli([s.project, '-cx', '--out', watchOut, '--watch=4s', '--verbose'], { home: s.home });
  assert.equal(r.code, 0, r.stderr);

  // Requirement 12: a hidden session is NOT demoted to a verdict-only cache
  // entry. Only sessions whose parsed data is retained can be reused, so a
  // later cycle reporting reuse for every discovered file is the observable
  // proof that the child is still held as `used`.
  const cycles = [...r.stdout.matchAll(/cache (\d+) reparsed \/ (\d+) reused/g)]
    .map(m => ({ reparsed: Number(m[1]), reused: Number(m[2]) }));
  assert.ok(cycles.length >= 2, `expected several cycles, got:\n${r.stdout}`);
  assert.equal(cycles[0].reused, 0, 'cycle 1 is a cold parse');
  const later = cycles[cycles.length - 1];
  assert.equal(later.reparsed, 0, 'nothing changed, so nothing may be re-read');
  assert.equal(later.reused, cycles[0].reparsed,
    'every file parsed in cycle 1 — the hidden child included — must still be reusable');

  // And the merge that depends on it still happened.
  const text = fs.readFileSync(path.join(watchOut, 'cxlog.md'), 'utf-8');
  assert.doesNotMatch(text, /Message Type: NEW_TASK/, 'the child itself stays hidden');
  assert.match(text, /Parent answer two/, 'the answer only the child recorded survives on the parent');
});

// ---------------------------------------------------------------------------
// §15.7 delegate replies are progress, not questions
//
// An inter-agent message travelling UP (a subagent answering the session that
// spawned it) is the delegator's own result. Filing it as a question split the
// delegating block in two and stranded the parent's real answer on a block whose
// question was the machine text `Message Type: FINAL_ANSWER …`; it also left the
// child's words on show under `includeSubagents: false`, since the parent's copy
// is not a subagent record. Direction — not the `Message Type` line — decides,
// because `MESSAGE` is observed travelling both ways.
// ---------------------------------------------------------------------------

// The mirror image of instruction(): the sender is BELOW the recipient.
function reply(ts, text, turnId) {
  return {
    timestamp: ts, type: 'response_item',
    payload: {
      type: 'agent_message', id: `amsg_${turnId}`, author: '/root/r1_review', recipient: '/root',
      content: [{ type: 'input_text', text }, { type: 'encrypted_content', encrypted_content: ENCRYPTED }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    },
  };
}

const FINAL_ANSWER = 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/r1_review\nPayload:\nCHILD-VERDICT-OK';
const UP_MESSAGE = 'Message Type: MESSAGE\nTask name: /root\nSender: /root/r1_review\nPayload:\nCHILD-STATUS-PING';
const DOWN_MESSAGE = 'Message Type: MESSAGE\nTask name: /root/r1_review\nSender: /root\nPayload:\nAlso check the tests';

const blockOf = (text, needle) =>
  text.split(/(?=<!-- ccxlogid:)/).find(b => b.includes(needle));

// A parent that delegates mid-turn and reports back once the reply lands.
function writeDelegatingParent(s, received = FINAL_ANSWER) {
  writeCodexSession(s.home, `rollout-2026-05-27T10-00-00-${PARENT_ID}.jsonl`, [
    rootMeta(s.project),
    ...turn('turn-1', PARENT_TS, s.project),
    userMsg(PARENT_TS, 'Spawn a reviewer and report back'),
    agentMsg(PARENT_TS, 'Delegating now'),
    marker(PARENT_TS),
    reply(PARENT_TS, received, 'turn-2'),
    ...turn('turn-2', PARENT_TS, s.project),
    agentMsg(PARENT_TS, 'The reviewer approved it'),
    taskComplete(PARENT_TS, 'The reviewer approved it'),
  ]);
}

test('cx dr 1: a reply from a subagent is progress — the delegating block keeps the human question and gains the answer', (t) => {
  const s = scaffold(t, 'ccx-delegreply-');
  writeDelegatingParent(s);

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 1,
    'the delegation must stay ONE block, not split at the reply');
  const block = blockOf(text, 'Spawn a reviewer and report back');
  assert.ok(block);
  assert.match(block, /The reviewer approved it/,
    "the parent's real answer belongs to the human question, not to a machine-text block");
  // The reply itself is progress, which the default template does not render.
  assert.doesNotMatch(text, /Message Type: FINAL_ANSWER/);
  assert.doesNotMatch(text, /CHILD-VERDICT-OK/);
});

test('cx dr 2: an upward MESSAGE is progress too — type alone does not decide', (t) => {
  const s = scaffold(t, 'ccx-delegping-');
  writeDelegatingParent(s, UP_MESSAGE);

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 1);
  assert.doesNotMatch(text, /CHILD-STATUS-PING/);
});

test('cx dr 3: a downward MESSAGE still opens a block — the child must not lose a follow-up', (t) => {
  const s = scaffold(t, 'ccx-delegdown-');
  writeCodexSession(s.home, `rollout-2026-05-27T12-00-00-${CHILD_ID}.jsonl`, [
    subagentMeta(s.project, { id: CHILD_ID, ts: CHILD_TS, nickname: 'reviewer' }),
    ...ownTurns(s.project, CHILD_TS, CHILD_TASK, 'Child answer to NEW_TASK', 'turn-child-1'),
    marker(CHILD_TS),
    instruction(CHILD_TS, DOWN_MESSAGE, 'turn-child-2'),
    ...turn('turn-child-2', CHILD_TS, s.project),
    agentMsg(CHILD_TS, 'Child answer to the follow-up'),
    taskComplete(CHILD_TS, 'Child answer to the follow-up'),
  ]);

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  assert.equal(countPairs(path.join(s.out, 'cxlog.md')), 2);
  assert.match(blockOf(text, 'NEW_TASK'), /Child answer to NEW_TASK/);
  assert.match(blockOf(text, 'Also check the tests'), /Child answer to the follow-up/);
});

test('cx dr 4: with the children hidden, nothing the child said survives on the parent', (t) => {
  const s = scaffold(t, 'ccx-delegoff-');
  writeDelegatingParent(s);
  writeCodexSession(s.home, `rollout-2026-05-27T12-00-00-${CHILD_ID}.jsonl`, [
    subagentMeta(s.project, { id: CHILD_ID, ts: CHILD_TS, nickname: 'reviewer' }),
    ...ownTurns(s.project, CHILD_TS, CHILD_TASK, 'CHILD-VERDICT-OK', 'turn-child-1'),
  ]);
  writeConfig(s.out, { codex: { includeSubagents: false } });

  assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
  const text = readOut(s);
  // This is what the option promises and what the parent's copy used to break.
  assert.doesNotMatch(text, /CHILD-VERDICT-OK/);
  assert.doesNotMatch(text, /Message Type:/);
  assert.match(text, /Spawn a reviewer and report back/);
  assert.match(text, /The reviewer approved it/);
});

test('cx dr 5: reclassifying a received message does not renumber the questions after it', (t) => {
  // The ccxlogId's question key for Codex is the positional `u-N` uuid, so a
  // received message that skipped the counter would reissue the id of every
  // later question in the session — blocks that have nothing to do with
  // subagents. Two runs differing ONLY in the direction of the received message
  // (question vs progress) must give the later question the same id.
  //
  // Each record carries its own timestamp, as real rollouts do. Questions
  // recorded in the SAME millisecond share a collision group whose ordinals are
  // counted over the questions present, so there — and only there — dropping one
  // question does move its neighbours; distinct timestamps isolate what this
  // test is about, which is the `u-N` counter.
  const T = (n) => `2026-05-27T10:00:0${n}.000Z`;
  const idOf = (received) => {
    const s = scaffold(t, 'ccx-delegseq-');
    writeCodexSession(s.home, `rollout-2026-05-27T10-00-00-${PARENT_ID}.jsonl`, [
      rootMeta(s.project, T(0)),
      ...turn('turn-1', T(1), s.project),
      userMsg(T(1), 'First question'),
      agentMsg(T(2), 'First answer'),
      marker(T(3)),
      received(T(3), 'turn-2'),
      ...turn('turn-2', T(4), s.project),
      agentMsg(T(5), 'Second answer'),
      ...turn('turn-3', T(6), s.project),
      userMsg(T(6), 'LATER-QUESTION'),
      agentMsg(T(7), 'Later answer'),
      taskComplete(T(7), 'Later answer'),
    ]);
    assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
    return ids(blockOf(readOut(s), 'LATER-QUESTION'))[0];
  };

  const asQuestion = idOf((ts, turnId) => instruction(ts, DOWN_MESSAGE, turnId));
  const asProgress = idOf((ts, turnId) => reply(ts, UP_MESSAGE, turnId));
  assert.ok(asQuestion);
  assert.equal(asProgress, asQuestion);
});
