import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../dist/lib/config.js';
import { mkTmp, rmrf } from './helpers.mjs';

// NOTE: fn is async, so this MUST await it before the finally deletes the temp
// dir — otherwise rmrf races the async loadConfig's read and the config file
// can vanish first, making a broken config read as "no file" (flaky under load).
async function withConfig(obj, fn) {
  const dir = mkTmp('ccx-cfg-');
  try {
    const raw = typeof obj === 'string' ? obj : JSON.stringify(obj);
    fs.writeFileSync(path.join(dir, 'ccxlog.config.json'), raw, 'utf-8');
    return await fn(dir);
  } finally {
    rmrf(dir);
  }
}

test('config: no file -> all defaults, no errors', async () => {
  const dir = mkTmp('ccx-cfg-');
  try {
    const { config, errors } = await loadConfig(dir, dir);
    assert.equal(errors.length, 0);
    assert.equal(config.outputAllFileName, 'ccxlog.md');
    assert.equal(config.claude.outputAllFileName, 'cclog.md');
    assert.equal(config.codex.outputAllFileName, 'cxlog.md');
  } finally { rmrf(dir); }
});

test('config: broken JSON is a fatal error, not a silent default', async () => {
  await withConfig('{ not json', async (dir) => {
    const { errors } = await loadConfig(dir, dir);
    assert.ok(errors.some(e => /not valid JSON/i.test(e)));
  });
});

test('config: non-object root is fatal', async () => {
  await withConfig('[]', async (dir) => {
    const { errors } = await loadConfig(dir, dir);
    assert.ok(errors.some(e => /root must be a JSON object/i.test(e)));
  });
});

test('config: reserved name with multiple extensions is rejected', async () => {
  await withConfig({ outputAllFileName: 'CON.a.b' }, async (dir) => {
    const { errors } = await loadConfig(dir, dir);
    assert.ok(errors.some(e => /reserved name/i.test(e)));
  });
});

test('config: DEL / C1 control chars in a name are rejected', async () => {
  await withConfig({ outputAllFileName: 'ab.md' }, async (dir) => {
    const { errors } = await loadConfig(dir, dir);
    assert.ok(errors.some(e => /control characters/i.test(e)));
  });
});

test('config: two identical aggregate names collide (code 1)', async () => {
  await withConfig({ outputAllFileName: 'same.md', claude: { outputAllFileName: 'same.md' } }, async (dir) => {
    const { errors } = await loadConfig(dir, dir);
    assert.ok(errors.some(e => /collide/i.test(e)));
  });
});

test('config: non-string filename warns and falls back (not silent)', async () => {
  await withConfig({ outputAllFileName: 123 }, async (dir) => {
    const { config, warnings, errors } = await loadConfig(dir, dir);
    assert.equal(errors.length, 0);
    assert.ok(warnings.some(w => /outputAllFileName must be a string/i.test(w)));
    assert.equal(config.outputAllFileName, 'ccxlog.md');
  });
});

test('config: explicit empty template is a fatal error', async () => {
  await withConfig({ template: '   ' }, async (dir) => {
    const { errors } = await loadConfig(dir, dir);
    assert.ok(errors.some(e => /empty value/i.test(e)));
  });
});

test('config: missing explicit template file is fatal (no silent fallback)', async () => {
  await withConfig({ template: 'templates/does-not-exist.md' }, async (dir) => {
    const { errors } = await loadConfig(dir, dir);
    assert.ok(errors.some(e => /not found/i.test(e)));
  });
});

test('config: path-separator, trailing-dot and empty aggregate names are fatal', async () => {
  const cases = [
    ['sub/dir.md', /path separators/i],
    ['a\\b.md', /path separators/i],
    ['trailing.md.', /space or period/i],
    ['', /must not be empty/i],
  ];
  for (const [name, re] of cases) {
    await withConfig({ outputAllFileName: name }, async (dir) => {
      const { errors } = await loadConfig(dir, dir);
      assert.ok(errors.some(e => re.test(e)), `expected a fatal error for ${JSON.stringify(name)}`);
    });
  }
});

test('config: boolean type mismatches warn and fall back to defaults', async () => {
  await withConfig({ claude: { recursive: 'yes' }, codex: { includeDeveloperMessages: 1 } }, async (dir) => {
    const { config, warnings, errors } = await loadConfig(dir, dir);
    assert.equal(errors.length, 0, errors.join('; '));
    assert.equal(config.claude.recursive, false);
    assert.equal(config.codex.includeDeveloperMessages, false);
    assert.ok(warnings.some(w => /claude\.recursive.*must be a boolean/i.test(w)));
    assert.ok(warnings.some(w => /codex\.includeDeveloperMessages.*must be a boolean/i.test(w)));
  });
});

test('config: unknown keys produce guidance warnings', async () => {
  await withConfig({ recursive: true, sources: 'x', claude: { bogus: 1 } }, async (dir) => {
    const { warnings } = await loadConfig(dir, dir);
    assert.ok(warnings.some(w => /claude\.\*.*codex\.\*/.test(w)));       // top-level recursive
    assert.ok(warnings.some(w => /source is selected on the CLI/.test(w))); // sources
    assert.ok(warnings.some(w => /unknown "claude\.bogus"/.test(w)));
  });
});
