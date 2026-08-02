// Shared fixture for the Progress-retention (memory reduction) tests.
//
// What lives here is a synthetic log that exercises every path where something
// OTHER than Progress depends on progressEntries. The regression tests that
// prove byte-invariance of the output pin the rendering of this fixture across
// three modes and four templates.
//
// The paths it exercises (all of which read progressEntries):
//   1. metaExtractor.extractModel        - a pair where only an in-progress entry has a model
//   2. metaExtractor.extractTokenTotals  - a pair whose usage rides on an in-progress entry
//   3. metaExtractor.anchorField         - a pair where cwd / version / gitBranch exist only
//                                          on an in-progress entry (%Cwd% and friends)
//   4. markdownWriter.buildAnswer        - a pair whose final assistant has no text, falling
//                                          back to an in-progress assistant's text
//   5. pairBuilder.recoverSlashCommandBodies - command body recovery from toolUseResult
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonl, encodeCwd } from './helpers.mjs';

export const SLASH_FULL_BODY = 'Do the thing.\nStep 1\nStep 2\nStep 3';
export const SLASH_TRUNCATED_BODY = 'Do the thing.\nStep 1';

const BIG_TOOL_RESULT = Array.from({ length: 12 }, (_, i) => `output line ${i}`).join('\n');

export const COMMAND_FILE_PATH = 'C:/fixture-home/.claude/commands/mycmd.md';

export function claudeRecords(project) {
  const cwdMeta = { cwd: project, version: '1.2.3', gitBranch: 'main' };
  return [
    { type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-05-27T11:00:00.000Z', ...cwdMeta,
      message: { role: 'user', content: 'First question' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-05-27T11:00:01.000Z', ...cwdMeta,
      message: { role: 'assistant', model: 'claude-opus-4-8', content: [
        { type: 'text', text: 'Let me look at the file.' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'C:/x/y.txt', limit: 100 } },
      ], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 3 } } } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-05-27T11:00:02.000Z', ...cwdMeta,
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: BIG_TOOL_RESULT },
      ] },
      toolUseResult: { file: { filePath: 'C:/x/y.txt', content: BIG_TOOL_RESULT } } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-05-27T11:00:03.000Z', ...cwdMeta,
      message: { role: 'assistant', model: 'claude-opus-4-8-inner', content: [
        { type: 'thinking', thinking: 'internal reasoning that only ProgressFull shows' },
        { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        { type: 'text', text: 'Intermediate note.' },
      ], usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0 } } },
    { type: 'assistant', uuid: 'a3', parentUuid: 'a2', timestamp: '2026-05-27T11:00:04.000Z', ...cwdMeta,
      message: { role: 'assistant', content: [
        { type: 'text', text: 'Final answer 1.' },
        { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'echo done' } },
      ], usage: { input_tokens: 1, output_tokens: 1 } } },

    { type: 'user', uuid: 'u3', parentUuid: 'a3', timestamp: '2026-05-27T11:10:00.000Z',
      message: { role: 'user', content: 'Second question' } },
    { type: 'assistant', uuid: 'a4', parentUuid: 'u3', timestamp: '2026-05-27T11:10:01.000Z',
      cwd: project, version: '9.9.9', gitBranch: 'feature/x',
      message: { role: 'assistant', model: 'claude-sonnet-5', content: [
        { type: 'text', text: 'Partial thought.' },
        { type: 'tool_use', id: 'tu3', name: 'Grep', input: { pattern: 'needle' } },
      ] } },
    { type: 'assistant', uuid: 'a5', parentUuid: 'a4', timestamp: '2026-05-27T11:10:02.000Z',
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'tu4', name: 'Write', input: { file_path: 'C:/x/z.txt' } },
      ] } },

    { type: 'user', uuid: 'u6', parentUuid: 'a5', timestamp: '2026-05-27T11:20:00.000Z', ...cwdMeta,
      message: { role: 'user', content: '<command-name>/mycmd</command-name>' } },
    { type: 'user', uuid: 'u7', parentUuid: 'u6', timestamp: '2026-05-27T11:20:01.000Z', ...cwdMeta,
      message: { role: 'user', content: SLASH_TRUNCATED_BODY } },
    { type: 'assistant', uuid: 'a7', parentUuid: 'u7', timestamp: '2026-05-27T11:20:02.000Z', ...cwdMeta,
      message: { role: 'assistant', model: 'claude-opus-4-8', content: [
        { type: 'tool_use', id: 'tu5', name: 'Read', input: { file_path: COMMAND_FILE_PATH } },
      ] } },
    { type: 'user', uuid: 'u8', parentUuid: 'a7', timestamp: '2026-05-27T11:20:03.000Z', ...cwdMeta,
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tu5', content: SLASH_FULL_BODY },
      ] },
      toolUseResult: { file: { filePath: COMMAND_FILE_PATH, content: SLASH_FULL_BODY } } },
    { type: 'assistant', uuid: 'a8', parentUuid: 'u8', timestamp: '2026-05-27T11:20:04.000Z', ...cwdMeta,
      message: { role: 'assistant', model: 'claude-opus-4-8', content: [
        { type: 'text', text: 'Final answer 3.' },
      ], usage: { input_tokens: 2, output_tokens: 2 } } },
  ];
}

export function codexRecords(project) {
  const T = (s) => `2026-05-27T12:0${s}:00.000Z`;
  return [
    { type: 'session_meta', timestamp: T(0), payload: {
      session_id: 'cx-sess-0001', cwd: project, cli_version: '0.9.9', git: { branch: 'main' } } },
    { type: 'turn_context', timestamp: T(0), payload: { turn_id: 't1', cwd: project, model: 'gpt-5-codex' } },
    { type: 'event_msg', timestamp: T(0), payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'event_msg', timestamp: T(1), payload: { type: 'user_message', message: 'Codex question one' } },
    { type: 'response_item', timestamp: T(2), payload: { type: 'reasoning', summary: [{ text: 'codex thinking' }] } },
    { type: 'response_item', timestamp: T(3), payload: {
      type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":"ls -la"}' } },
    { type: 'response_item', timestamp: T(4), payload: {
      type: 'function_call_output', call_id: 'c1', output: BIG_TOOL_RESULT } },
    { type: 'event_msg', timestamp: T(5), payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30,
        reasoning_output_tokens: 5, total_tokens: 155 } } } },
    { type: 'event_msg', timestamp: T(6), payload: { type: 'agent_message', message: 'Codex answer one.' } },
    { type: 'event_msg', timestamp: T(7), payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 150, cached_input_tokens: 20, output_tokens: 45,
        reasoning_output_tokens: 9, total_tokens: 224 } } } },
    { type: 'event_msg', timestamp: T(8), payload: { type: 'task_complete', last_agent_message: 'Codex answer one.' } },

    { type: 'turn_context', timestamp: T(9), payload: { turn_id: 't2', cwd: project, model: 'gpt-5-codex' } },
    { type: 'event_msg', timestamp: T(9), payload: { type: 'task_started', turn_id: 't2' } },
    { type: 'event_msg', timestamp: T(9), payload: { type: 'user_message', message: 'Codex question two' } },
    { type: 'response_item', timestamp: T(9), payload: { type: 'reasoning', summary: [{ text: 'interrupted' }] } },
  ];
}

export const CODEX_ROLLOUT_NAME = 'rollout-2026-05-27T12-00-00-019f-codex-9999.jsonl';

export function writeProgressFixture(home, project) {
  fs.mkdirSync(project, { recursive: true });
  writeJsonl(
    path.join(home, '.claude', 'projects', encodeCwd(project), 'sess1.jsonl'),
    claudeRecords(project),
  );
  writeJsonl(
    path.join(home, '.codex', 'sessions', '2026', '05', '27', CODEX_ROLLOUT_NAME),
    codexRecords(project),
  );
}


const BASE = `<!-- %CcxlogId% -->
# %DateTime% [%Source%/%SourceShort%] %SessionName%:%SessionId%
Model=%Model% Version=%Version%
Branch=%GitBranch% Cwd=%Cwd%
Tokens=%Tokens%
## Question
%Question%
## Answer
%Answer%
`;

export const TEMPLATES = {
  none: `${BASE}--------\n\n`,
  summary: `${BASE}## Progress\n%Progress%\n--------\n\n`,
  full: `${BASE}## ProgressFull\n%ProgressFull%\n--------\n\n`,
  both: `${BASE}## Progress\n%Progress%\n## ProgressFull\n%ProgressFull%\n--------\n\n`,
};

export const MODES = { ccxlog: [], cc: ['-cc'], cx: ['-cx'] };
export const AGGREGATE_NAME = { ccxlog: 'ccxlog.md', cc: 'cclog.md', cx: 'cxlog.md' };

export function useTemplate(out, key) {
  fs.mkdirSync(path.join(out, 'templates'), { recursive: true });
  const rel = `templates/t-${key}.md`;
  fs.writeFileSync(path.join(out, rel), TEMPLATES[key], 'utf-8');
  fs.writeFileSync(path.join(out, 'ccxlog.config.json'),
    JSON.stringify({ template: rel, watchIntervalSeconds: 1 }, null, 2), 'utf-8');
}

export function normalize(text, { home, project }) {
  const variants = (p) => [p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')];
  let out = text;
  for (const p of variants(project)) out = out.split(p).join('<PROJECT>');
  for (const p of variants(home)) out = out.split(p).join('<HOME>');
  return out;
}
