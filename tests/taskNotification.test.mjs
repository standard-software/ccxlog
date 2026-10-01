// The aggregate output skips pairs that are nothing but a harness-injected
// <task-notification> block with no answer (src/lib/taskNotification.ts).
// These tests pin down the exact boundary: only notification-only questions
// with an empty answer disappear, and only from the aggregate output.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  mkTmp, rmrf, writeClaudeSession, claudeQA, runCli, countPairs,
} from './helpers.mjs';

const NOTIFICATION = [
  '<task-notification>',
  '<task-id>bw8p7txhf</task-id>',
  '<status>completed</status>',
  '<summary>Background command "watch" completed (exit code 0)</summary>',
  '</task-notification>',
].join('\n');

// One user record with no assistant reply -> a pair with an empty answer.
function unansweredQuestion(projectPath, { q, ts, uuid }) {
  return [
    { type: 'user', uuid, parentUuid: null, timestamp: ts, cwd: projectPath, version: '1.0.0', gitBranch: 'main',
      message: { role: 'user', content: q } },
  ];
}

function setup() {
  const home = mkTmp('ccx-notif-home-');
  const project = mkTmp('ccx-notif-proj-');
  // s1: notification only, no answer -> the one pair the aggregate must skip.
  writeClaudeSession(home, project, 's1.jsonl', unansweredQuestion(project, {
    q: NOTIFICATION, ts: '2026-05-27T11:01:00.000Z', uuid: 'n1',
  }));
  // s2: two notification blocks, still nothing else, no answer -> skipped too.
  writeClaudeSession(home, project, 's2.jsonl', unansweredQuestion(project, {
    q: `${NOTIFICATION}\n\n${NOTIFICATION}`, ts: '2026-05-27T11:02:00.000Z', uuid: 'n2',
  }));
  // s3: notification question but the turn answered -> real content, kept.
  writeClaudeSession(home, project, 's3.jsonl', claudeQA(project, {
    q: NOTIFICATION, a: 'The build finished; all tests pass.',
    ts: '2026-05-27T11:03:00.000Z', uuid: 'n3',
  }));
  // s4: user text alongside the notification, no answer -> kept.
  writeClaudeSession(home, project, 's4.jsonl', unansweredQuestion(project, {
    q: `please also run the linter\n${NOTIFICATION}`,
    ts: '2026-05-27T11:04:00.000Z', uuid: 'n4',
  }));
  // s5: an ordinary conversation, the control.
  writeClaudeSession(home, project, 's5.jsonl', claudeQA(project, {
    ts: '2026-05-27T11:05:00.000Z', uuid: 'n5',
  }));
  return { home, project };
}

test('aggregate skips only notification-only pairs with no answer', (t) => {
  const { home, project } = setup();
  t.after(() => { rmrf(home); rmrf(project); });

  const r = runCli([project, '--verbose'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Skipped 2 task-notification pair\(s\) with no answer\./);

  const md = fs.readFileSync(path.join(project, 'CCXLOG', 'ccxlog.md'), 'utf-8');
  assert.equal(countPairs(path.join(project, 'CCXLOG', 'ccxlog.md')), 3);
  assert.match(md, /The build finished; all tests pass\./);
  assert.match(md, /please also run the linter/);
  assert.match(md, /Hello Claude/);
  // Only the kept questions still carry the tag: one block from s3 and one
  // from s4. The three blocks of s1/s2 are gone.
  assert.equal((md.match(/<task-notification>/g) ?? []).length, 2);
});

test('per-session output keeps every pair, notifications included', (t) => {
  const { home, project } = setup();
  t.after(() => { rmrf(home); rmrf(project); });

  const r = runCli([project, '-cc', '--per-session'], { home });
  assert.equal(r.code, 0, r.stderr);

  const outDir = path.join(project, 'CCXLOG');
  const files = fs.readdirSync(outDir).filter(f => f.startsWith('cclog_'));
  assert.equal(files.length, 5);
  const all = files.map(f => fs.readFileSync(path.join(outDir, f), 'utf-8')).join('\n');
  assert.match(all, /bw8p7txhf/);
});

test('a quiet run does not mention the filter', (t) => {
  const home = mkTmp('ccx-notif-home-');
  const project = mkTmp('ccx-notif-proj-');
  t.after(() => { rmrf(home); rmrf(project); });
  writeClaudeSession(home, project, 's1.jsonl', claudeQA(project));

  const r = runCli([project, '--verbose'], { home });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /task-notification/);
});
