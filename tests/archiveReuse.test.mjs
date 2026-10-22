// Reusing an unchanged archive under --watch (ArchiveMemo in index.ts) rests on
// isDestructiveWithSharedTail() giving exactly the answer of the full
// comparison. That is checked here against isDestructive() on randomly built
// documents full of the cases the id parsing treats specially.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const dist = (...p) => new URL(`../dist/${p.join('/')}`, import.meta.url).href;
const { chooseMethod, isDestructive, isDestructiveWithSharedTail, sharedTail } =
  await import(dist('lib', 'identity.js'));

// Small deterministic PRNG so a failure can be reproduced from its seed.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 2 ** 32;
  };
}

const ID_POOL = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(24, '0'));
const TIMES = [1000, 2000, 3000, 4000, 5000];

function line(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const k = r();
  if (k < 0.22) return `<!-- ccxlogid:${pick(ID_POOL)} time:${pick(TIMES)} -->`;
  if (k < 0.36) return `<!-- ccxlogid:${pick(ID_POOL)} -->`;                 // no time: legacy heading decides
  if (k < 0.39) return `<!-- ccxlogid:${pick(ID_POOL)} time:unknown -->`;
  if (k < 0.41) return '<!-- ccxlogid:not-an-id -->';                         // malformed
  if (k < 0.55) return `# 1970/01/01 Thu 09:00:0${Math.floor(r() * 6)}   [ClaudeCode]`; // legacy heading
  if (k < 0.70) return '';
  return `text ${Math.floor(r() * 100)}`;
}

function doc(r, maxLines) {
  const n = Math.floor(r() * maxLines);
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(line(r));
  return lines.length ? lines.join('\n') + '\n' : '';
}

function fullAnswer(oldHead, newHead, tail, since, through) {
  const oldC = oldHead + tail;
  const newC = newHead + tail;
  return isDestructive(oldC, newC, chooseMethod(oldC, newC).method, since, through);
}

test('isDestructiveWithSharedTail agrees with the full comparison on random documents', () => {
  const seen = { none: 0, kept: 0, lost: 0 };
  for (let seed = 1; seed <= 20000; seed++) {
    const r = rng(seed);
    const tail = doc(r, 12);
    const oldHead = doc(r, 10);
    // Often the new head is the old one with a little changed, as in a watch.
    const newHead = r() < 0.5 ? oldHead + doc(r, 4) : doc(r, 10);
    const since = r() < 0.5 ? undefined : TIMES[Math.floor(r() * TIMES.length)];
    const through = since !== undefined && r() < 0.5 ? since + 1500 : undefined;
    const quick = isDestructiveWithSharedTail(oldHead, newHead, sharedTail(tail), since, through);
    assert.notEqual(quick, null, `seed ${seed}: heads end at a line boundary`);
    const full = fullAnswer(oldHead, newHead, tail, since, through);
    assert.equal(quick, full, `seed ${seed}\n--- old\n${oldHead}--- new\n${newHead}--- tail\n${tail}`);
    const method = chooseMethod(oldHead + tail, newHead + tail).method;
    seen[method === 'none' ? 'none' : full ? 'lost' : 'kept']++;
  }
  // Every kind of answer must actually occur, or the comparison proves little:
  // undecidable, ids kept, and ids lost (with and without the time window).
  assert.ok(seen.none > 500 && seen.kept > 500 && seen.lost > 500, JSON.stringify(seen));
});

test('a head that does not end at a line boundary is left to the full comparison', () => {
  const tail = sharedTail(`<!-- ccxlogid:${ID_POOL[0]} time:1 -->\nbody\n`);
  assert.equal(isDestructiveWithSharedTail('no newline', '', tail), null);
  assert.equal(isDestructiveWithSharedTail('', 'no newline', tail), null);
});
