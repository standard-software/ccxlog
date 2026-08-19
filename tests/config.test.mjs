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
    assert.equal(config.recentDays, 8);
    assert.equal(config.autoBackupGraceMinutes, 10);
  } finally { rmrf(dir); }
});

test('config: autoBackupGraceMinutes accepts only integer minutes from 1 through 60', async () => {
  for (const value of [1, 10, 60]) {
    await withConfig({ autoBackupGraceMinutes: value }, async (dir) => {
      const { config, errors } = await loadConfig(dir, dir);
      assert.equal(errors.length, 0);
      assert.equal(config.autoBackupGraceMinutes, value);
    });
  }
  for (const value of [0, -1, 1.5, 61, '10', null]) {
    await withConfig({ autoBackupGraceMinutes: value }, async (dir) => {
      const { errors } = await loadConfig(dir, dir);
      assert.ok(errors.some(e => /autoBackupGraceMinutes.*integer from 1 through 60.*minutes/i.test(e)));
    });
  }
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






// Output names are fixed since v2 of the config surface (shipped in 1.9.0).
// The old keys must FAIL the run rather than vanish into the unknown-key
// warning: silently ignoring them would redirect output to the fixed name and
// leave the user's renamed file behind, unread — exactly the quiet-loss shape
// the removal was meant to end.
test('config: every removed output-name key is a fatal error naming the fixed name', async () => {
  const cases = [
    [{ outputAllFileName: 'log.md' }, /outputAllFileName is no longer supported.*ccxlog\.md/i],
    [{ claude: { outputAllFileName: 'c.md' } }, /claude\.outputAllFileName is no longer supported.*cclog\.md/i],
    [{ codex: { outputAllFileName: 'x.md' } }, /codex\.outputAllFileName is no longer supported.*cxlog\.md/i],
    [{ claude: { outputSessionFilePrefix: 'p_' } }, /claude\.outputSessionFilePrefix is no longer supported.*cclog_/i],
    [{ codex: { outputSessionFilePrefix: 'q_' } }, /codex\.outputSessionFilePrefix is no longer supported.*cxlog_/i],
  ];
  for (const [cfg, re] of cases) {
    await withConfig(cfg, async (dir) => {
      const { errors } = await loadConfig(dir, dir);
      assert.ok(errors.some(e => re.test(e)), `expected a fatal error for ${JSON.stringify(cfg)}, got: ${errors.join(' | ')}`);
    });
  }
});

test('config: a removed key is fatal even when set to its old default', async () => {
  // The value being harmless does not make the key harmless: accepting the
  // default spelling would keep dead configuration alive in the wild.
  await withConfig({ outputAllFileName: 'ccxlog.md' }, async (dir) => {
    const { errors } = await loadConfig(dir, dir);
    assert.ok(errors.some(e => /outputAllFileName is no longer supported/i.test(e)));
  });
});

test('config: recentDays accepts integers >= 1 and otherwise warns and uses 8', async () => {
  await withConfig({ recentDays: 31 }, async (dir) => {
    const { config, warnings } = await loadConfig(dir, dir);
    assert.equal(config.recentDays, 31);
    assert.equal(warnings.length, 0);
  });
  for (const value of [0, -1, 1.5, '15', null]) {
    await withConfig({ recentDays: value }, async (dir) => {
      const { config, warnings, errors } = await loadConfig(dir, dir);
      assert.equal(errors.length, 0);
      assert.equal(config.recentDays, 8);
      assert.ok(warnings.some(w => /recentDays must be an integer of 1 or greater/i.test(w)));
    });
  }
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


test('config: boolean type mismatches warn and fall back to defaults', async () => {
  await withConfig({ claude: { includeSidechain: 'yes' }, codex: { includeDeveloperMessages: 1 } }, async (dir) => {
    const { config, warnings, errors } = await loadConfig(dir, dir);
    assert.equal(errors.length, 0, errors.join('; '));
    // The former name resolves into includeSubagents, whose default is true.
    assert.equal(config.claude.includeSubagents, true);
    assert.equal(config.codex.includeDeveloperMessages, false);
    assert.ok(warnings.some(w => /claude\.includeSidechain.*must be a boolean/i.test(w)));
    assert.ok(warnings.some(w => /codex\.includeDeveloperMessages.*must be a boolean/i.test(w)));
  });
});

test('config: removed recursive keys and unknown keys produce guidance warnings', async () => {
  await withConfig({ recursive: true, sources: 'x', claude: { recursive: true, bogus: 1 }, codex: { recursive: false } }, async (dir) => {
    const { warnings } = await loadConfig(dir, dir);
    assert.ok(warnings.some(w => /recursion is selected automatically/.test(w)));
    assert.ok(warnings.some(w => /claude\.recursive.*no longer supported.*non-recursive/i.test(w)));
    assert.ok(warnings.some(w => /codex\.recursive.*no longer supported.*recursive/i.test(w)));
    assert.ok(warnings.some(w => /source is selected on the CLI/.test(w))); // sources
    assert.ok(warnings.some(w => /unknown "claude\.bogus"/.test(w)));
  });
});
