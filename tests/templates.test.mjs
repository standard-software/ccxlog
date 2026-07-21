import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderTemplate, defangComment, hasBothProgress, templateHasSource,
  unknownPlaceholders, DEFAULT_TEMPLATE,
} from '../dist/lib/templates.js';

test('renderTemplate: replacement is literal ($&, $1, $$ are not special)', () => {
  const out = renderTemplate('Q=%Question%', { Question: 'has $& and $1 and $$ tokens' });
  assert.equal(out, 'Q=has $& and $1 and $$ tokens');
});

test('renderTemplate: a value containing another placeholder is NOT cross-injected', () => {
  // Single-pass replacement: %Question%'s value literally contains "%Answer%",
  // which must survive verbatim rather than being replaced by the Answer value.
  const out = renderTemplate('Q:%Question% A:%Answer%', {
    Question: 'see %Answer% below', Answer: 'SECRET',
  });
  assert.equal(out, 'Q:see %Answer% below A:SECRET');
});

test('renderTemplate: same placeholder replaced everywhere', () => {
  const out = renderTemplate('%Source% ... %Source%', { Source: 'Codex' });
  assert.equal(out, 'Codex ... Codex');
});

test('renderTemplate: defangs both <!-- and --> in the 4 content vars', () => {
  for (const key of ['Question', 'Answer', 'Progress', 'ProgressFull']) {
    const out = renderTemplate(`X %${key}% Y`, { [key]: 'a --> b <!-- c' });
    assert.ok(!out.includes('-->'), `${key} should not leak -->`);
    assert.ok(!out.includes('<!--'), `${key} should not leak <!--`);
    assert.ok(out.includes('-- >') && out.includes('<! --'));
  }
});

test('renderTemplate: non-content vars are not defanged', () => {
  const out = renderTemplate('%Model%', { Model: 'x-->y' });
  assert.equal(out, 'x-->y');
});

test('defangComment neutralizes comment tokens', () => {
  assert.equal(defangComment('<!-- x -->'), '<! -- x -- >');
});

test('progress helpers reflect the template', () => {
  assert.equal(hasBothProgress('%Progress% %ProgressFull%'), true);
  assert.equal(hasBothProgress('%Progress%'), false);
  assert.equal(templateHasSource('has %Source%'), true);
  assert.equal(templateHasSource('none'), false);
});

test('unknownPlaceholders: known ones ignored, unknown reported once', () => {
  assert.deepEqual(unknownPlaceholders(DEFAULT_TEMPLATE), []);
  assert.deepEqual(unknownPlaceholders('%Question% %Bogus% %Answer% %Bogus%'), ['Bogus']);
});
