// Shared helpers for the ccxlog test suite. Tests run against the COMPILED
// output in dist/ (built by the `pretest` step), and use only synthetic
// fixtures written into a throwaway fake HOME — never the real ~/.claude or
// ~/.codex — so they are fully independent of any real logs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(ROOT, 'dist', 'index.js');

// Claude's project-dir encoding: every non-[a-zA-Z0-9] char becomes '-'.
export function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// A fresh throwaway directory under the OS temp dir.
export function mkTmp(prefix = 'ccx-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

export function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = records.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf-8');
}

// Write a Claude session file into <home>/.claude/projects/<encoded>/<name>.
export function writeClaudeSession(home, projectPath, name, records) {
  const dir = path.join(home, '.claude', 'projects', encodeCwd(projectPath));
  writeJsonl(path.join(dir, name), records);
}

// Write a Codex rollout under <home>/.codex/sessions/<y>/<m>/<d>/<name>.
export function writeCodexSession(home, name, records, [y, m, d] = ['2026', '05', '27']) {
  const dir = path.join(home, '.codex', 'sessions', y, m, d);
  writeJsonl(path.join(dir, name), records);
}

// Build a minimal Claude session: one question + one answer.
export function claudeQA(projectPath, {
  q = 'Hello Claude', a = 'Hi from Claude', ts = '2026-05-27T11:03:49.000Z',
  uuid = 'u1', model = 'claude-opus-4-8',
} = {}) {
  return [
    { type: 'user', uuid, parentUuid: null, timestamp: ts, cwd: projectPath, version: '1.0.0', gitBranch: 'main',
      message: { role: 'user', content: q } },
    { type: 'assistant', uuid: 'a-' + uuid, parentUuid: uuid, timestamp: ts, cwd: projectPath, version: '1.0.0', gitBranch: 'main',
      message: { role: 'assistant', model, content: [{ type: 'text', text: a }], usage: { input_tokens: 6, output_tokens: 33, cache_read_input_tokens: 21758 } } },
  ];
}

// Build a minimal Codex rollout: one question + one answer.
export function codexQA(projectPath, {
  q = 'Hello Codex', a = 'Hi from Codex', ts = '2026-05-27T11:04:49.000Z',
  sessionId = '019f-codex-0001', model = 'gpt-5',
} = {}) {
  return [
    { type: 'session_meta', timestamp: ts, payload: { session_id: sessionId, cwd: projectPath, cli_version: '0.5.0', git: { branch: 'main' } } },
    { type: 'turn_context', timestamp: ts, payload: { turn_id: 't1', cwd: projectPath, model } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message: q } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'agent_message', message: a } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5 } } } },
    { type: 'event_msg', timestamp: ts, payload: { type: 'task_complete', last_agent_message: a } },
  ];
}

// Run the compiled CLI with a fake HOME so discovery only sees our fixtures.
export function runCli(args, { home, cwd = ROOT } = {}) {
  const env = { ...process.env };
  if (home) {
    env.HOME = home;
    env.USERPROFILE = home;      // os.homedir() reads USERPROFILE on Windows
    env.HOMEDRIVE = '';
    env.HOMEPATH = '';
  }
  const res = spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: 'utf-8' });
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Count formal ccxlogid markers in a rendered file.
export function countPairs(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  return (text.match(/<!-- ccxlogid:[0-9a-f]{24} -->/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// Integration helpers (ported from the old-develop suite). These favour the
// extraLogDirs-pinned discovery style: a throwaway workspace with dedicated
// cc-logs / cx-logs roots, a fake HOME, and config written to <out>. They let
// the ported mode/discovery/backup/edge/lifecycle/per-session tests read
// almost verbatim while still exercising the real compiled CLI.
// ---------------------------------------------------------------------------

// A throwaway workspace registered for cleanup on the test's teardown.
// Returns { root, project, out, home, ccLogs, cxLogs }.
export function workspace(t) {
  const root = mkTmp('ccx-ws-');
  const project = path.join(root, 'project');
  const out = path.join(project, 'CCXLOG');
  const home = path.join(root, 'home');
  const ccLogs = path.join(root, 'cc-logs');
  const cxLogs = path.join(root, 'cx-logs');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  if (t) t.after(() => rmrf(root));
  return { root, project, out, home, ccLogs, cxLogs };
}

// Run the compiled CLI. Mirrors runCli but exposes `status` (the field the
// ported assertions use) alongside `code`.
export function run(args, { home, cwd = ROOT } = {}) {
  const r = runCli(args, { home, cwd });
  return { status: r.code, code: r.code, stdout: r.stdout, stderr: r.stderr };
}

export function writeConfig(outDir, config) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'ccxlog.config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

export function writeRaw(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf-8');
}

export function read(p) {
  return fs.readFileSync(p, 'utf-8');
}

export function exists(p) {
  return fs.existsSync(p);
}
