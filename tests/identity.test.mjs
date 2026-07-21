import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assignCcxids, safeSessionId, encodeSid64, decodeSid64,
  parseCcxlogId, chooseMethod, regionFromLine, isDestructive,
} from '../dist/lib/identity.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function mkPair(o = {}) {
  const raw = o.questionTimestampRaw ?? '2026-05-27T11:03:49.000Z';
  return {
    source: o.source ?? 'claude',
    sourceLabel: 'ClaudeCode',
    sessionId: o.sessionId ?? 's1',
    sessionName: '',
    sourceFile: '/abs/x.jsonl',
    sourceFileRelativeId: o.sourceFileRelativeId ?? 'claude/standard/std/x.jsonl',
    questionEventUuid: o.questionEventUuid,
    questionOrdinal: o.questionOrdinal ?? 0,
    questionTimestampRaw: raw,
    questionTimestampMs: Date.parse(raw),
    question: o.question ?? 'Question text',
    progressSummary: '', progressFull: '',
    answer: o.answer ?? '',
    model: '', version: '', gitBranch: '', cwd: '', tokens: {},
    ccxid: '', fileContentHash: '', eventIdStreamHash: [],
  };
}

test('source health: separators use the \\0 escape, never a raw NUL byte in source', () => {
  // §9.2 field separator must be a real NUL at runtime, but written as the \0
  // ESCAPE in source so the .ts files stay text-clean (git/diff/editor safe).
  const files = ['lib/identity.ts', 'sources/claude/jsonlReader.ts', 'sources/codex/jsonlReader.ts', 'lib/merge.ts'];
  for (const rel of files) {
    const buf = fs.readFileSync(path.join(SRC, rel));
    assert.ok(!buf.includes(0x00), `${rel} must not contain a raw 0x00 NUL byte`);
  }
  // The escape is actually present where the ccxid material is joined.
  const idText = fs.readFileSync(path.join(SRC, 'lib/identity.ts'), 'utf-8');
  assert.ok(idText.includes('\\0'), 'identity.ts must join ccxid material with the \\0 escape');
});

test('ccxid: the \\0 separator still delimits fields at runtime (no boundary ambiguity)', () => {
  // "a" + sep + "bc"  vs  "ab" + sep + "c" must differ — proves the escape
  // compiles to a real separator, not an empty string.
  const p1 = mkPair({ source: 'claude', sessionId: 'a', questionTimestampRaw: 'bc2026', question: 'Q' });
  const p2 = mkPair({ source: 'claude', sessionId: 'ab', questionTimestampRaw: 'c2026', question: 'Q' });
  assignCcxids([p1]);
  assignCcxids([p2]);
  assert.notEqual(p1.ccxid, p2.ccxid);
});

test('ccxlogId: 24 hex digits and ccxlogid: prefix', () => {
  const p = mkPair();
  assignCcxids([p]);
  assert.match(p.ccxid, /^ccxlogid:[0-9a-f]{24}$/);
});

test('ccxid: answer / model / tokens / absolute path do NOT change it', () => {
  const base = mkPair({ answer: '' });
  assignCcxids([base]);
  const id1 = base.ccxid;
  const changed = mkPair({ answer: 'a full streamed answer' });
  changed.model = 'gpt-9'; changed.tokens = { input: 999 }; changed.sourceFile = '/elsewhere/y.jsonl';
  assignCcxids([changed]);
  assert.equal(changed.ccxid, id1);
});

test('ccxid: same-second twins with no uuid get distinct ids', () => {
  const t1 = mkPair({ question: 'Twin', questionOrdinal: 0 });
  const t2 = mkPair({ question: 'Twin', questionOrdinal: 1 });
  assignCcxids([t1, t2]);
  assert.notEqual(t1.ccxid, t2.ccxid);
});

test('ccxid: field boundaries use NUL, not space (§9.2) — no cross-field ambiguity', () => {
  // These two pairs are DIFFERENT logical pairs whose ccxid material would be
  // byte-identical if the fields were joined with a SPACE:
  //   P1: (sessionId="s x", timestampRaw="2026")  -> "claude s x 2026 <qk> 0"
  //   P2: (sessionId="s",   timestampRaw="x 2026") -> "claude s x 2026 <qk> 0"
  // With a real NUL (\0) join they differ, so they MUST get distinct ccxids.
  // This guards against a regression to space separators (the r3 reports read
  // NUL as a space and wrongly claimed a bug — this test makes the truth
  // machine-checkable).
  const q = 'identical question body';
  const p1 = mkPair({ source: 'claude', sessionId: 's x', questionTimestampRaw: '2026', question: q });
  const p2 = mkPair({ source: 'claude', sessionId: 's', questionTimestampRaw: 'x 2026', question: q });
  assignCcxids([p1, p2]);
  assert.notEqual(p1.ccxid, p2.ccxid);
});

test('ccxid: unrelated earlier pairs do not shift a later id', () => {
  const p = mkPair({ sessionId: 's', questionTimestampRaw: '2026-05-27T12:00:00.000Z' });
  assignCcxids([p]);
  const alone = p.ccxid;
  const p2 = mkPair({ sessionId: 's', questionTimestampRaw: '2026-05-27T12:00:00.000Z' });
  const earlier = mkPair({ sessionId: 's', questionTimestampRaw: '2026-05-27T09:00:00.000Z' });
  assignCcxids([earlier, p2]);
  assert.equal(p2.ccxid, alone); // different timestamp group -> unaffected
});

test('safeSessionId: trailing whitespace leaves no trailing underscore', () => {
  assert.equal(safeSessionId('abc   ', 'rid'), 'abc');
  assert.equal(safeSessionId('abc.', 'rid'), 'abc');
});

test('safeSessionId: reserved names blocked incl. multi-extension', () => {
  assert.equal(safeSessionId('CON', 'rid'), '_CON');
  assert.equal(safeSessionId('con.a.b', 'rid'), '_con.a.b');
});

test('safeSessionId: forbidden and path chars are neutralized', () => {
  assert.equal(safeSessionId('a/b\\c', 'rid'), 'a__b__c');
  assert.equal(safeSessionId('a<b>c:d', 'rid'), 'a_b_c_d');
});

test('safeSessionId: empty result falls back to a stable hash name', () => {
  const out = safeSessionId('   ', 'relative-id');
  assert.match(out, /^session-[0-9a-f]{16}$/);
});

test('sid64: Base64url round-trips even for hostile ids', () => {
  for (const id of ['plain', 'a-->b', 'line\nbreak', 'ec5e9974-80a6']) {
    const enc = encodeSid64(id);
    assert.match(enc, /^[A-Za-z0-9_-]+$/); // no --, no newline: comment-safe
    assert.equal(decodeSid64(enc), id);
  }
});

test('sid64: undecodable value returns null (never deleted)', () => {
  assert.equal(decodeSid64('has spaces'), null);
});

test('block parsing: ccxlogid markers, 40-hyphen noise does not split blocks', () => {
  const body = [
    '<!-- ccxlogid:aaaaaaaaaaaaaaaaaaaaaaaa -->',
    '# heading', 'answer with a rule:', '----------------------------------------',
    'more answer',
    '<!-- ccxlogid:bbbbbbbbbbbbbbbbbbbbbbbb -->',
    'second',
  ].join('\n');
  const p = parseCcxlogId(body);
  assert.equal(p.count, 2);
  assert.ok(p.valid);
  assert.deepEqual(p.ids, ['ccxlogid:aaaaaaaaaaaaaaaaaaaaaaaa', 'ccxlogid:bbbbbbbbbbbbbbbbbbbbbbbb']);
});

test('block parsing: chooseMethod uses ccxlogid and isDestructive on id loss', () => {
  const oldBody = '<!-- ccxlogid:aaaaaaaaaaaaaaaaaaaaaaaa -->\nx\n<!-- ccxlogid:bbbbbbbbbbbbbbbbbbbbbbbb -->\ny';
  const newDrop = '<!-- ccxlogid:aaaaaaaaaaaaaaaaaaaaaaaa -->\nx';
  const { method } = chooseMethod(oldBody, newDrop);
  assert.equal(method, 'ccxlogid');
  assert.equal(isDestructive(oldBody, newDrop, 'ccxlogid'), true);   // bbbb… vanished
  assert.equal(isDestructive(oldBody, oldBody, 'ccxlogid'), false);
});

test('block parsing: datetime headings are not identities', () => {
  const body = '# 2026/05/27 Wed 11:03:49   [Codex]\ntext';
  assert.equal(parseCcxlogId(body).count, 0);
  assert.equal(chooseMethod(body, body).method, 'none');
});

test('regionFromLine: slices from the first marker line to EOF', () => {
  const body = 'preamble\n<!-- ccxlogid:aaaaaaaaaaaaaaaaaaaaaaaa -->\nblock';
  const region = regionFromLine(body, 1);
  assert.ok(region.startsWith('<!-- ccxlogid:'));
  assert.ok(!region.includes('preamble'));
});

// ---- ports from old-develop unit-identity.test.mjs -------------------------

test('ccxid: ignores sourceFileRelativeId while a sessionId is present', () => {
  // Two copies of the same logical pair discovered under different roots (so
  // their relative ids differ) must get the SAME ccxid: the id keys off the
  // sessionId, not the file's location.
  const a = mkPair({ sessionId: 's', sourceFileRelativeId: 'claude/standard/std/one.jsonl' });
  const b = mkPair({ sessionId: 's', sourceFileRelativeId: 'claude/extra/HASH/deep/other.jsonl' });
  assignCcxids([a]);
  assignCcxids([b]);
  assert.equal(a.ccxid, b.ccxid);
});

test('ccxid: twin assignment is order-independent (collision ordinal by question order)', () => {
  const mk = () => [mkPair({ question: 'Twin', questionOrdinal: 0 }), mkPair({ question: 'Twin', questionOrdinal: 1 })];
  const a = mk(); assignCcxids(a);
  const b = mk().reverse(); assignCcxids(b);
  const byOrdinal = arr => arr.slice().sort((x, y) => x.questionOrdinal - y.questionOrdinal).map(p => p.ccxid);
  assert.deepEqual(byOrdinal(a), byOrdinal(b));
});

test('block parsing: duplicate / malformed ccxlogid markers make the method unsafe (none)', () => {
  const owner = '<!-- ccxlog-owner:ccxlog; kind:aggregate; mode:both -->';
  const malformed = owner + '\n<!-- ccxlogid:not-a-real-id -->\nbody\n';
  const good = owner + '\n<!-- ccxlogid:aaaaaaaaaaaaaaaaaaaaaaaa -->\nx\n';
  assert.equal(chooseMethod(malformed, good).method, 'none');
});
