import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, mkTmp, rmrf, runCli, writeClaudeSession, writeCodexSession, writeJsonl,
  claudeQA, codexQA, countPairs,
} from './helpers.mjs';

// Build a fake HOME with one Claude session and one Codex session that both
// belong to a real project dir. Returns { home, project, out, cleanup }.
function scaffold({ claude = true, codex = true } = {}) {
  const home = mkTmp('ccx-home-');
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const out = path.join(project, 'CCXLOG');
  if (claude) writeClaudeSession(home, project, 'sess1.jsonl', claudeQA(project));
  if (codex) writeCodexSession(home, 'rollout-2026-05-27T11-04-49-019f-codex-0001.jsonl', codexQA(project));
  return { home, project, out, cleanup: () => rmrf(home) };
}

test('mode both: merges Claude + Codex into ccxlog.md with correct %Source%', () => {
  const s = scaffold();
  try {
    const r = runCli([s.project], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    const file = path.join(s.out, 'ccxlog.md');
    assert.equal(countPairs(file), 2);
    const text = fs.readFileSync(file, 'utf-8');
    assert.ok(text.includes('[ClaudeCode]'));
    assert.ok(text.includes('[Codex]'));
    assert.doesNotMatch(text, /^Source=(?:ClaudeCode|Codex)/m);
  } finally { s.cleanup(); }
});

test('-cc writes only cclog.md and does not touch the other aggregates', () => {
  const s = scaffold();
  try {
    const r = runCli([s.project, '-cc'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(s.out, 'cclog.md')));
    assert.ok(!fs.existsSync(path.join(s.out, 'ccxlog.md')));
    assert.ok(!fs.existsSync(path.join(s.out, 'cxlog.md')));
    const text = fs.readFileSync(path.join(s.out, 'cclog.md'), 'utf-8');
    assert.ok(text.includes('[ClaudeCode]') && !text.includes('[Codex]'));
  } finally { s.cleanup(); }
});

test('-cx writes only cxlog.md; three modes coexist', () => {
  const s = scaffold();
  try {
    assert.equal(runCli([s.project], { home: s.home }).code, 0);
    assert.equal(runCli([s.project, '-cc'], { home: s.home }).code, 0);
    assert.equal(runCli([s.project, '-cx'], { home: s.home }).code, 0);
    for (const f of ['ccxlog.md', 'cclog.md', 'cxlog.md']) {
      assert.ok(fs.existsSync(path.join(s.out, f)), `${f} should exist`);
    }
    const cx = fs.readFileSync(path.join(s.out, 'cxlog.md'), 'utf-8');
    assert.ok(cx.includes('[Codex]') && !cx.includes('[ClaudeCode]'));
  } finally { s.cleanup(); }
});

test('output contract: no BOM, LF only, trailing newline, %SourceShort%', () => {
  const s = scaffold();
  try {
    runCli([s.project], { home: s.home });
    const buf = fs.readFileSync(path.join(s.out, 'ccxlog.md'));
    assert.notEqual(buf[0], 0xef); // no UTF-8 BOM
    assert.ok(!buf.includes(0x0d)); // no CR
    assert.equal(buf[buf.length - 1], 0x0a); // trailing LF
  } finally { s.cleanup(); }
});

test('idempotent: second run is noop and preserves mtime', () => {
  const s = scaffold();
  try {
    runCli([s.project], { home: s.home });
    const file = path.join(s.out, 'ccxlog.md');
    const m1 = fs.statSync(file).mtimeMs;
    const r2 = runCli([s.project], { home: s.home });
    assert.match(r2.stdout, /\[noop\]/);
    assert.equal(fs.statSync(file).mtimeMs, m1);
  } finally { s.cleanup(); }
});

test('per-session: source-prefixed files for both sources', () => {
  const s = scaffold();
  try {
    const r = runCli([s.project, '--per-session'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(s.out, 'cclog_sess1.md')));
    assert.ok(fs.existsSync(path.join(s.out, 'cxlog_019f-codex-0001.md')));
    assert.ok(!fs.existsSync(path.join(s.out, 'ccxlog.md'))); // no aggregate in per-session
  } finally { s.cleanup(); }
});

test('aggregate mode prints per-session result lines with the source (§3.4)', () => {
  const s = scaffold();
  try {
    const r = runCli([s.project], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    // §3.4 requires per-session result lines in aggregate mode too, not only
    // in per-session mode.
    assert.match(r.stdout, /\[claude:[^\]]+\] 1 pair\(s\)/);
    assert.match(r.stdout, /\[codex:[^\]]+\] 1 pair\(s\)/);
  } finally { s.cleanup(); }
});

test('per-session: case-only filename collision is rejected on win32 (§4.4)', { skip: process.platform !== 'win32' }, () => {
  const home = mkTmp('ccx-home-');
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const out = path.join(project, 'CCXLOG');
  try {
    // Two Codex sessions whose ids differ only in case -> cxlog_ABC.md and
    // cxlog_abc.md, which collide on the case-insensitive win32 filesystem.
    writeCodexSession(home, 'rollout-a.jsonl', codexQA(project, { sessionId: 'ABC' }));
    writeCodexSession(home, 'rollout-b.jsonl', codexQA(project, { sessionId: 'abc', q: 'Q2', a: 'A2' }));
    const r = runCli([project, '--per-session'], { home });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /collision/i);
    // Nothing was written for the colliding pair (write-before-check aborted).
    assert.ok(!fs.existsSync(out) || fs.readdirSync(out).every(f => !/^cxlog_/i.test(f)));
  } finally { rmrf(home); }
});

test('destructive rewrite backs up before overwriting', () => {
  const s = scaffold();
  try {
    runCli([s.project], { home: s.home });
    // Remove the Codex log so a pair vanishes on the next run -> destructive.
    rmrf(path.join(s.home, '.codex'));
    const r = runCli([s.project], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[rewrite\]/);
    const backups = path.join(s.out, 'backup_CCXLOG_md');
    assert.ok(fs.existsSync(backups));
    const stamped = fs.readdirSync(backups);
    assert.ok(stamped.length >= 1);
    assert.ok(fs.readdirSync(path.join(backups, stamped[0])).includes('ccxlog.md'));
  } finally { s.cleanup(); }
});

test('logical dedupe: an extraLogDirs full copy is emitted once', () => {
  const s = scaffold({ claude: false });
  try {
    const extra = path.join(s.home, 'codex-backup');
    // Exact byte copy of the standard rollout in an explicit extra root.
    writeJsonl(path.join(extra, 'copy.jsonl'), codexQA(s.project));
    fs.mkdirSync(s.out, { recursive: true });
    fs.writeFileSync(path.join(s.out, 'ccxlog.config.json'),
      JSON.stringify({ codex: { extraLogDirs: [extra] } }), 'utf-8');
    const r = runCli([s.project, '--verbose'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(countPairs(path.join(s.out, 'ccxlog.md')), 1); // deduped, not 2
  } finally { s.cleanup(); }
});

test('template safety: literal + comment defang survive round-trip', () => {
  const s = scaffold({ codex: false });
  try {
    writeClaudeSession(s.home, s.project, 'sess1.jsonl',
      claudeQA(s.project, { q: 'has $& and $1', a: 'answer with --> and <!-- inside' }));
    runCli([s.project], { home: s.home });
    const text = fs.readFileSync(path.join(s.out, 'ccxlog.md'), 'utf-8');
    assert.ok(text.includes('has $& and $1'));           // literal, not regex-expanded
    const body = text.slice(text.indexOf('## Question'));
    assert.ok(!body.includes('answer with --> and')); // the --> was defanged
    assert.ok(text.includes('-- >') && text.includes('<! --'));
  } finally { s.cleanup(); }
});

test('backup-md with nothing to back up exits 0', () => {
  const s = scaffold({ claude: false, codex: false });
  try {
    const r = runCli([s.project, '--backup-md'], { home: s.home });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /No files to back up/);
  } finally { s.cleanup(); }
});

test('all sources empty -> exit code 1, no output written', () => {
  const s = scaffold({ claude: false, codex: false });
  try {
    const r = runCli([s.project], { home: s.home });
    assert.equal(r.code, 1);
    assert.ok(!fs.existsSync(path.join(s.out, 'ccxlog.md')));
  } finally { s.cleanup(); }
});

test('--dry-run writes nothing', () => {
  const s = scaffold();
  try {
    const r = runCli([s.project, '--dry-run'], { home: s.home });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(s.out, 'ccxlog.md')));
  } finally { s.cleanup(); }
});

test('usage errors: -cc -cx and unknown flag exit code 2', () => {
  const s = scaffold({ claude: false, codex: false });
  try {
    assert.equal(runCli([s.project, '-cc', '-cx'], { home: s.home }).code, 2);
    assert.equal(runCli([s.project, '--frobnicate'], { home: s.home }).code, 2);
    assert.equal(runCli([s.project, '-cc', '--source', 'codex'], { home: s.home }).code, 2);
  } finally { s.cleanup(); }
});

test('init-template self-copy: when --out IS the package root, config-only, no "already exists" error (§7.4 step3)', () => {
  // Package root's own template dir is the copy SOURCE; with --out === package
  // root the destination equals the source, so §7.4 step3 says reconcile config
  // only. --dry-run keeps this side-effect-free while still exercising the
  // self-copy detection (a regression cx4 hit: it errored "already exists").
  const r = runCli(['--init-template', '--out', ROOT, '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /already exists/i);
  assert.match(r.stdout, /dest is the source file itself/i);
});

test('a duplicate extra-root alias key mapping to two dirs is fatal (§5.5)', () => {
  const s = scaffold({ claude: false, codex: false });
  try {
    fs.mkdirSync(s.out, { recursive: true });
    fs.writeFileSync(path.join(s.out, 'ccxlog.config.json'),
      JSON.stringify({ claude: { extraLogDirs: [{ dir: 'a', key: 'dup' }, { dir: 'b', key: 'dup' }] } }), 'utf-8');
    const r = runCli([s.project], { home: s.home });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /namespace key/i);
  } finally { s.cleanup(); }
});

test('aggregate name collision is rejected before writing (code 1)', () => {
  const s = scaffold();
  try {
    fs.mkdirSync(s.out, { recursive: true });
    fs.writeFileSync(path.join(s.out, 'ccxlog.config.json'),
      JSON.stringify({ outputAllFileName: 'same.md', claude: { outputAllFileName: 'same.md' } }), 'utf-8');
    const r = runCli([s.project], { home: s.home });
    assert.equal(r.code, 1);
    assert.ok(!fs.existsSync(path.join(s.out, 'same.md')));
  } finally { s.cleanup(); }
});
