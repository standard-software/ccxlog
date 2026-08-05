#!/usr/bin/env node
// Classify every difference between two rendered ccxlog outputs.
//
// The release requirement behind this script is "for every block that
// disappeared, be able to state why". Eyeballing a 10 MB diff cannot do that,
// and comparing a new run against a stored baseline cannot either: the logs
// keep growing, so a plain diff mixes real removals with everything that has
// simply happened since. The procedure this script is built for pins BOTH sides
// to the same input instead:
//
//   1. build the released version somewhere else, at the same moment:
//        git archive <old-ref> | tar -x -C /tmp/ccxlog-old
//        (cd /tmp/ccxlog-old && npm ci && npm run build)
//   2. run both builds against the SAME project, into two different output
//      directories. Copy ccxlog.config.json into each one first — the config
//      lives in the OUTPUT directory, and without it discovery covers a
//      different set of logs and the comparison is meaningless:
//        node /tmp/ccxlog-old/dist/index.js <project> --out /tmp/out-old
//        node ./dist/index.js               <project> --out /tmp/out-new
//   3. node tools/compare-blocks.mjs /tmp/out-old/cxlog.md /tmp/out-new/cxlog.md
//
// ## Why this compares more than the question text
//
// The first version of this script skipped every block whose ccxlogid survived
// (`if (newIds.has(b.id)) continue`) and bucketed the rest by how many times
// their QUESTION text occurred. Both halves of that are too weak:
//
//   - A block can keep its id and have its CONTENT replaced. That is precisely
//     the corruption an earlier generation of this feature shipped — a parent
//     block whose answer was overwritten with a child's — and a
//     question-text-only comparison reports it as 0 differences.
//   - "The same question appears fewer times" is not evidence of a duplicate
//     removal. A question genuinely asked twice, and two blocks sharing a
//     question but differing in answer, progress or session, are all
//     mislabelled by it.
//
// So blocks are parsed into fields — question, answer, progress, tokens,
// source, session, thread — and every axis takes part. Content that MOVED
// matters as much as content that vanished.
//
// ## Buckets
//
// gone (an id in the old output and not in the new one):
//   id-changed         the same question AND answer are in the new output under
//                      a different id — expected: this change moves session ids
//                      and raw timestamps, both ccxlogid material (method A).
//   duplicate-removed  a block with the same question and a compatible answer
//                      survives, and there are fewer of them than before — the
//                      re-recorded copies.
//   answer-merged      the question survives and the surviving copy now carries
//                      an answer this one did not — the child-only answer
//                      folded into the original pair.
//   re-split           the question survives and this block's answer is now
//                      some OTHER block's answer: rendering received
//                      instructions as questions of their own put a boundary
//                      inside what used to be one pair.
//   absorbed           the question survives and what this block showed as its
//                      answer is a PROGRESS line of a surviving block — a copy
//                      taken while the turn was still running, ending on a
//                      message the finished turn shows as progress. Only
//                      visible when the template renders Progress, so run the
//                      comparison a second time with a %ProgressFull%
//                      template to close these.
//   internal-context   the "question" was injected context nobody typed
//                      (<codex_internal_context> / <recommended_plugins>).
//   UNEXPLAINED        nothing in the new output accounts for it. The release
//                      criterion is that this bucket is empty.
//
// added (an id in the new output and not in the old one):
//   instruction        a subagent instruction the old version never rendered as
//                      a question of its own.
//   id-changed         the other side of the bucket above.
//   new-content        a question the old output does not contain at all —
//                      normally the logs having grown between the two runs, so
//                      a non-zero count is only meaningful when both runs saw
//                      the same input.
//
// kept (an id in both), which the old script did not look at at all:
//   unchanged          identical fields.
//   enriched           strictly MORE than before: an answer where there was
//                      none, progress that still contains what was there,
//                      token fields that grew. This is what merging into the
//                      original pair is supposed to look like.
//   re-split           its tail moved into a block of its own (see above), so
//                      its answer, progress and usage now end earlier. The old
//                      answer is still in the output, under the instruction
//                      that actually elicited it.
//   MUTATED            anything else — a different answer, a different
//                      question, a moved session/thread/timestamp, progress or
//                      tokens that SHRANK. Each is printed in full.
//
// Exit code is 1 while anything is UNEXPLAINED or MUTATED, so the check can
// gate a release.
import fs from 'node:fs';

// Anchored to a whole line, because a rendered block can CONTAIN the marker
// text: with a %Progress% template, a tool that read a ccxlog.md puts its
// contents — markers and all — inside another block. Splitting on an unanchored
// match tears such a block in half and invents ids that are not blocks.
const BLOCK = /^<!-- ccxlogid:([0-9a-f]{24}) -->$/m;
const BLOCK_SPLIT = /(?=^<!-- ccxlogid:[0-9a-f]{24} -->$)/m;

// Injected context the CLI writes as a user message but nobody typed. Requiring
// these to reappear in the new output would be backwards: removing them is the
// point (§ requirement 6).
const INTERNAL_CONTEXT = ['<codex_internal_context>', '<recommended_plugins>'];

// Section headings the default template emits — used both to find a section and
// to know where the previous one ends.
const HEADINGS = new Set(['## Question', '## Answer', '## Progress']);

function parseBlocks(file) {
  const text = fs.readFileSync(file, 'utf-8');
  const parts = text.split(BLOCK_SPLIT).filter(p => BLOCK.test(p));
  return parts.map((body) => {
    const meta = header(body);
    return {
      ...meta,
      id: BLOCK.exec(body)[1],
      body,
      question: section(body, 'Question'),
      answer: section(body, 'Answer'),
      // Progress is compared as a LIST: the question asked of it is "does the
      // new one still hold everything the old one had", which is a subsequence
      // check, not a string compare.
      progress: section(body, 'Progress').split('\n').filter(Boolean),
      // Overwrites meta.tokens (the raw line) with the parsed field map.
      tokens: parseTokens(meta.tokens),
    };
  });
}

// The template's metadata lines. A field the template does not emit comes back
// as '' on BOTH sides and therefore drops out of the comparison, so a custom
// template still works — it just compares on fewer axes.
function header(body) {
  const head = body.split('\n## ')[0];
  const title = /^# (.*?)\s{2,}\[(ClaudeCode|Codex)\] Session:(.*):([^:\n]*)$/m.exec(head);
  return {
    datetime: title?.[1] ?? '',
    source: title?.[2] ?? '',
    sessionName: title?.[3] ?? '',
    sessionId: title?.[4] ?? '',
    model: /^Model=(.*?) Version=/m.exec(head)?.[1] ?? '',
    branch: /^Branch=(.*?) Cwd=/m.exec(head)?.[1] ?? '',
    tokens: /^Tokens=(.*)$/m.exec(head)?.[1] ?? '',
  };
}

// "in 50, out 200, cache read 7, reasoning 9" -> { in: 50, out: 200, … }.
// A field neither side reports is absent from both maps and never compared,
// which keeps a defined 0 distinguishable from "never reported" (§6.1).
//
// Split on the field NAMES, not on commas: the numbers are rendered with
// thousands separators, so `line.split(',')` tears "in 91,548,264" into three
// pieces and silently reports 91.
const TOKEN_FIELD = /(cache read|cache write|reasoning|in|out)\s+([\d,]+)/g;

function parseTokens(line) {
  const out = {};
  for (const m of line.matchAll(TOKEN_FIELD)) out[m[1]] = Number(m[2].replace(/,/g, ''));
  return out;
}

// The text under a "## <name>" heading, up to the next heading or the block
// separator. Scanned line by line rather than with one regex: a question can
// contain blank lines, its own '## ' lines and dashed rules, and a regex that
// stops at the first of those silently truncates the very text the comparison
// depends on.
function section(body, name) {
  const lines = body.split('\n');
  const start = lines.indexOf(`## ${name}`);
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (HEADINGS.has(line)) break;
    if (/^-{10,}$/.test(line)) break;
    if (line === '-->') continue;      // an empty answer is rendered commented out
    if (line === '<!--') continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

function groupBy(blocks, keyOf) {
  const map = new Map();
  for (const b of blocks) {
    const key = keyOf(b);
    const arr = map.get(key);
    if (arr) arr.push(b); else map.set(key, [b]);
  }
  return map;
}

/** Is `a` an ordered subsequence of `b`? The same rule the merge itself uses. */
function contains(b, a) {
  if (a.length > b.length) return false;
  let i = 0;
  for (const item of b) if (i < a.length && a[i] === item) i++;
  return i === a.length;
}

function excerpt(text, max = 90) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// markdownWriter renders an assistant message into Progress as
// `- (assistant) <oneLine(text)>`, flattened and cut at 200 characters. Rebuilt
// here so an answer that became a progress line can be recognised as the same
// text (see `absorbed` below).
const PROGRESS_ASSISTANT = '- (assistant) ';

function oneLine(s) {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
}

// Every way the new copy of a block may legitimately differ from the old one:
// an answer where there was none, progress that still contains what was there,
// token fields that only grew, and the tail of the pair having moved into a
// block of its own. Anything else is a mutation.
function compareKept(oldB, newB, doc) {
  const changes = [];
  const enrichments = [];
  const moved = [];

  for (const field of ['question', 'datetime', 'source', 'sessionName', 'sessionId', 'model', 'branch']) {
    if (oldB[field] !== newB[field]) {
      changes.push(`${field}: ${JSON.stringify(oldB[field])} -> ${JSON.stringify(newB[field])}`);
    }
  }
  // Rendering received instructions as questions of their own puts a boundary
  // in the middle of what used to be one pair. The block keeps its id and its
  // question, and everything after the boundary — the answer it used to end
  // on, the progress and the usage behind it — belongs to the new block from
  // now on. Finding that content ELSEWHERE in the new output is what tells the
  // move apart from an overwrite.
  if (oldB.answer !== newB.answer) {
    if (!oldB.answer) enrichments.push('answer gained');
    else if (doc.stillPresent(oldB.answer)) moved.push('its answer is now another block\'s');
    else changes.push(`answer: ${JSON.stringify(excerpt(oldB.answer))} -> ${JSON.stringify(excerpt(newB.answer))}`);
  }
  if (oldB.progress.join('\n') !== newB.progress.join('\n')) {
    if (contains(newB.progress, oldB.progress)) {
      enrichments.push(`progress ${oldB.progress.length} -> ${newB.progress.length}`);
    } else {
      const lost = oldB.progress.filter(line => !newB.progress.includes(line));
      if (lost.every(line => doc.progressLines.has(line))) {
        moved.push(`progress ${oldB.progress.length} -> ${newB.progress.length} (the rest is in other blocks)`);
      } else {
        changes.push(`progress no longer contains what it had (${oldB.progress.length} -> ${newB.progress.length})`);
      }
    }
  }
  // Usage belongs to the records it was reported against, so when those records
  // moved into another block the counts follow them. Only a block that did NOT
  // give anything up is expected to keep every token it had.
  if (!moved.length) {
    for (const [field, value] of Object.entries(oldB.tokens)) {
      const now = newB.tokens[field];
      if (now === undefined) changes.push(`tokens.${field} disappeared (was ${value})`);
      else if (now < value) changes.push(`tokens.${field} shrank ${value} -> ${now}`);
      else if (now > value) enrichments.push(`tokens.${field} ${value} -> ${now}`);
    }
    for (const field of Object.keys(newB.tokens)) {
      if (oldB.tokens[field] === undefined) enrichments.push(`tokens.${field} gained`);
    }
  }
  return { changes, enrichments, moved };
}

// ---------------------------------------------------------------------------

const [oldFile, newFile] = process.argv.slice(2);
if (!oldFile || !newFile) {
  console.error('usage: node tools/compare-blocks.mjs <old.md> <new.md>');
  process.exit(2);
}

const oldBlocks = parseBlocks(oldFile);
const newBlocks = parseBlocks(newFile);
const oldById = new Map(oldBlocks.map(b => [b.id, b]));
const newById = new Map(newBlocks.map(b => [b.id, b]));
const newByQuestion = groupBy(newBlocks, b => b.question);
const oldByQuestion = groupBy(oldBlocks, b => b.question);
// The (question, answer) pair is what "the same block, elsewhere" means. Keying
// on the question alone is what let a question genuinely asked twice look like
// a removed duplicate.
const qa = b => `${b.question} ${b.answer}`;
const newByQA = groupBy(newBlocks, qa);
const oldByQA = groupBy(oldBlocks, qa);
// Where content can still be, once it is no longer where it was: as some
// block's answer, or as a line of some block's Progress. Text found in either
// did not disappear, it moved.
const newAnswers = new Set(newBlocks.map(b => b.answer).filter(Boolean));
const newProgressLines = new Set(newBlocks.flatMap(b => b.progress));
const newProgressAssistant = new Set(
  [...newProgressLines].filter(l => l.startsWith(PROGRESS_ASSISTANT)).map(l => l.slice(PROGRESS_ASSISTANT.length)),
);
const doc = {
  progressLines: newProgressLines,
  // An answer that became a Progress line is the shape § requirement 5 turns
  // on: a copy taken mid-turn ends on a message the finished turn shows as
  // progress, so absorbing it loses nothing. Only visible when the template
  // renders Progress — with the default one this check simply never fires.
  stillPresent: text => newAnswers.has(text) || newProgressAssistant.has(oneLine(text)),
};

// ---- blocks whose id survived ---------------------------------------------

const kept = { unchanged: [], enriched: [], 're-split': [], MUTATED: [] };
for (const b of oldBlocks) {
  const now = newById.get(b.id);
  if (!now) continue;
  const { changes, enrichments, moved } = compareKept(b, now, doc);
  if (changes.length) kept.MUTATED.push({ block: b, changes });
  else if (moved.length) kept['re-split'].push({ block: b, moved });
  else if (enrichments.length) kept.enriched.push({ block: b, enrichments });
  else kept.unchanged.push(b);
}

// ---- blocks that are gone --------------------------------------------------

const gone = new Map([
  ['id-changed', []], ['duplicate-removed', []], ['answer-merged', []],
  ['re-split', []], ['absorbed', []], ['internal-context', []], ['UNEXPLAINED', []],
]);

for (const b of oldBlocks) {
  if (newById.has(b.id)) continue;
  const sameQA = newByQA.get(qa(b)) ?? [];
  const sameQuestion = newByQuestion.get(b.question) ?? [];
  if (INTERNAL_CONTEXT.some(p => b.question.startsWith(p))) {
    gone.get('internal-context').push(b);
  } else if (sameQuestion.length === 0) {
    gone.get('UNEXPLAINED').push(b);
  } else if (sameQA.length > 0 && sameQA.length < (oldByQA.get(qa(b)) ?? []).length) {
    // Fewer copies of this exact question AND answer than there were: the
    // re-recorded copies went and one representative stayed.
    gone.get('duplicate-removed').push(b);
  } else if (!b.answer && sameQuestion.some(s => s.answer)) {
    gone.get('answer-merged').push(b);
  } else if (sameQA.length > 0) {
    // The same question and answer are in the new output under another id.
    gone.get('id-changed').push(b);
  } else if (b.answer && newAnswers.has(b.answer)) {
    // The question survives, and this block's answer is now the answer of some
    // other block: the pair was split at a received-instruction boundary and
    // its tail became a block of its own. Nothing was lost.
    gone.get('re-split').push(b);
  } else if (b.answer && newProgressAssistant.has(oneLine(b.answer))) {
    // The question survives and what this copy showed as its answer is a
    // PROGRESS line of a surviving block: the copy was taken while the turn was
    // still running, so it ended on a message the finished turn shows as
    // progress. Absorbing it loses nothing — this is § requirement 5's rule,
    // read back out of the rendered output.
    gone.get('absorbed').push(b);
  } else if (!b.answer && sameQuestion.length > 0) {
    // No answer to lose, and the question is still there.
    gone.get('duplicate-removed').push(b);
  } else {
    // The question is there, but nothing accounts for the answer or the
    // progress this block carried — exactly the case the old, question-only
    // classification called "duplicate-removed" without evidence.
    gone.get('UNEXPLAINED').push(b);
  }
}

// ---- blocks that are new ---------------------------------------------------

const added = new Map([['instruction', []], ['id-changed', []], ['new-content', []]]);
for (const b of newBlocks) {
  if (oldById.has(b.id)) continue;
  if (b.question.startsWith('Message Type:')) added.get('instruction').push(b);
  else if (oldByQuestion.has(b.question)) added.get('id-changed').push(b);
  else added.get('new-content').push(b);
}

// ---- report ----------------------------------------------------------------

console.log(`old: ${oldBlocks.length} block(s)  ${oldFile}`);
console.log(`new: ${newBlocks.length} block(s)  ${newFile}`);
console.log(`kept the same id: ${Object.values(kept).reduce((n, arr) => n + arr.length, 0)}`);
for (const [name, arr] of Object.entries(kept)) console.log(`  ${name}: ${arr.length}`);
console.log('gone:');
for (const [name, arr] of gone) console.log(`  ${name}: ${arr.length}`);
console.log('added:');
for (const [name, arr] of added) console.log(`  ${name}: ${arr.length}`);

if (kept.enriched.length) {
  console.log('\n--- enriched (kept its id, strictly more content) ---');
  for (const { block, enrichments } of kept.enriched.slice(0, 40)) {
    console.log(`ccxlogid:${block.id}  ${enrichments.join('; ')}   ${excerpt(block.question, 50)}`);
  }
  if (kept.enriched.length > 40) console.log(`… and ${kept.enriched.length - 40} more`);
}

if (kept['re-split'].length) {
  console.log('\n--- re-split (kept its id; its tail is now in other blocks) ---');
  for (const { block, moved } of kept['re-split'].slice(0, 40)) {
    console.log(`ccxlogid:${block.id}  ${moved.join('; ')}   ${excerpt(block.question, 50)}`);
  }
  if (kept['re-split'].length > 40) console.log(`… and ${kept['re-split'].length - 40} more`);
}

if (kept.MUTATED.length) {
  console.log('\n--- MUTATED: these kept their ccxlogid but their content changed ---');
  for (const { block, changes } of kept.MUTATED) {
    console.log(`\nccxlogid:${block.id}   ${excerpt(block.question, 60)}`);
    for (const c of changes) console.log(`  ${c}`);
  }
}

const unexplained = gone.get('UNEXPLAINED');
if (unexplained.length) {
  console.log('\n--- UNEXPLAINED: nothing in the new output accounts for these ---');
  for (const b of unexplained) {
    console.log(`\nccxlogid:${b.id}`);
    console.log(b.body.trim().split('\n').slice(0, 12).join('\n'));
  }
}

process.exit(unexplained.length || kept.MUTATED.length ? 1 : 0);
