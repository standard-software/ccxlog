import { sha256Hex, sha256HexBytes } from './pathUtils.js';
import type { UnifiedPair } from './types.js';

// ---- ccxlogId (answer-independent stable id, hex 24 / 96-bit) — §9.2 -----

function questionKeyOf(u: UnifiedPair): string {
  return u.questionEventUuid && u.questionEventUuid.length
    ? u.questionEventUuid
    : sha256Hex(u.question);
}

// Assign collisionOrdinal within each (source, sessionId, questionTimestampRaw)
// group, then compute the ccxlogId. Mutates each pair's internal `ccxid` field.
export function assignCcxids(pairs: UnifiedPair[]): void {
  const groups = new Map<string, UnifiedPair[]>();
  for (const p of pairs) {
    const key = `${p.source}\0${p.sessionId}\0${p.questionTimestampRaw}`;
    const arr = groups.get(key);
    if (arr) arr.push(p); else groups.set(key, [p]);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => {
      const au = a.questionEventUuid ?? '';
      const bu = b.questionEventUuid ?? '';
      if (au || bu) {
        if (au < bu) return -1;
        if (au > bu) return 1;
      }
      const ah = sha256Hex(a.question);
      const bh = sha256Hex(b.question);
      if (ah < bh) return -1;
      if (ah > bh) return 1;
      const at = `${a.sourceFileRelativeId}\0${a.questionOrdinal}`;
      const bt = `${b.sourceFileRelativeId}\0${b.questionOrdinal}`;
      if (at < bt) return -1;
      if (at > bt) return 1;
      return 0;
    });
    arr.forEach((p, i) => {
      const sessionKey = p.sessionId || p.sourceFileRelativeId;
      const material = `${p.source}\0${sessionKey}\0${p.questionTimestampRaw}\0${questionKeyOf(p)}\0${i}`;
      p.ccxid = `ccxlogid:${sha256HexBytes(material, 24)}`;
    });
  }
}

// ---- sid64 (Base64url session-id encode/decode for markers) — §8.4 -------

export function encodeSid64(sessionId: string): string {
  return Buffer.from(sessionId, 'utf-8').toString('base64url');
}

export function decodeSid64(sid64: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sid64)) return null;
  try {
    return Buffer.from(sid64, 'base64url').toString('utf-8');
  } catch {
    return null;
  }
}

// ---- safe session id for per-session file names — §8.4 -------------------

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeSessionId(sessionId: string, sourceFileRelativeId: string): string {
  // Strip trailing whitespace and periods FIRST, from the raw id, so nothing
  // survives as a trailing '_' once internal whitespace runs are collapsed
  // below (§8.4). Doing this after the collapse — as an earlier version did —
  // left a trailing '_' for ids ending in whitespace.
  let s = sessionId.replace(/[\s.]+$/u, '');
  s = s.replace(/[/\\]/g, '__');
  // Other Windows-forbidden chars, control chars and DEL -> '_'.
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f || '<>:"|?*'.includes(ch)) out += '_';
    else out += ch;
  }
  s = out.replace(/\s+/g, '_');
  s = s.replace(/[ .]+$/, '');
  // Reserved-name base is everything before the FIRST dot (Windows blocks
  // "CON.a.b" too), not just before the last extension.
  if (WIN_RESERVED.test(s.split('.')[0])) s = `_${s}`;

  const bytes = Buffer.from(s, 'utf-8');
  if (bytes.length > 120) {
    // Truncate to <=100 bytes on a char boundary + hash suffix.
    let cut = '';
    let used = 0;
    for (const ch of s) {
      const chBytes = Buffer.byteLength(ch, 'utf-8');
      if (used + chBytes > 100) break;
      cut += ch;
      used += chBytes;
    }
    s = `${cut}_${sha256HexBytes(sessionId, 16)}`;
  }
  if (s === '') s = `session-${sha256HexBytes(sourceFileRelativeId, 16)}`;
  return s;
}

// ---- block parsing (§9.1) ------------------------------------------------

export type BlockMethod = 'ccxlogid' | 'none';

const CCXLOG_ID_MARKER_RE = /^<!-- (ccxlogid:[0-9a-f]{24}) -->$/;
const CCXLOG_ID_LOOSE_RE = /^<!-- ccxlogid:/;

export interface CcxlogIdParse {
  count: number;
  ids: string[];
  valid: boolean;          // no duplicate ids and no malformed ccxlogid lines
  firstLineIndex: number;  // -1 if none
}

export function parseCcxlogId(content: string): CcxlogIdParse {
  const lines = content.split('\n');
  const ids: string[] = [];
  let invalid = false;
  let firstLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!CCXLOG_ID_LOOSE_RE.test(line)) continue;
    const m = CCXLOG_ID_MARKER_RE.exec(line);
    if (m) {
      if (firstLineIndex === -1) firstLineIndex = i;
      ids.push(m[1]);
    } else {
      invalid = true;
    }
  }
  const dup = new Set(ids).size !== ids.length;
  return { count: ids.length, ids, valid: !invalid && !dup, firstLineIndex };
}

// Choose the comparison method between two document bodies (§9.1).
export function chooseMethod(oldContent: string, newContent: string): {
  method: BlockMethod;
  oldFirstLine: number;
  newFirstLine: number;
} {
  const oc = parseCcxlogId(oldContent);
  const nc = parseCcxlogId(newContent);
  if (oc.count > 0 && nc.count > 0 && oc.valid && nc.valid) {
    return { method: 'ccxlogid', oldFirstLine: oc.firstLineIndex, newFirstLine: nc.firstLineIndex };
  }
  return { method: 'none', oldFirstLine: -1, newFirstLine: -1 };
}

// Substring from the given line index to EOF (byte-exact for LF content).
export function regionFromLine(content: string, lineIndex: number): string {
  if (lineIndex < 0) return content;
  return content.split('\n').slice(lineIndex).join('\n');
}

export function idsByMethod(content: string, method: BlockMethod): string[] {
  if (method === 'ccxlogid') return parseCcxlogId(content).ids;
  return [];
}

// Destructive rewrite = at least one old block id is absent from the new body.
export function isDestructive(oldContent: string, newContent: string, method: BlockMethod): boolean {
  if (method === 'none') return true; // indeterminate -> back up defensively
  const newIds = new Set(idsByMethod(newContent, method));
  for (const id of idsByMethod(oldContent, method)) {
    if (!newIds.has(id)) return true;
  }
  return false;
}

// ---- safe-amendment detection (backup-free rewrite) ------------------------
// A rewrite is a "safe amendment" when it provably loses no information from
// the old body. The common real-world case: the previous run rendered a pair
// whose session was still answering (empty Answer, `Model=` / `Tokens=` not
// yet known); the next run fills that same block in and appends new pairs.
// That is not a strict tail-extension, so it used to be a full rewrite WITH a
// pre-overwrite backup — piling up one backup per run on projects where some
// session is always live. Detecting it lets planWrite skip the backup while
// still backing up every rewrite that could actually lose or reorder content.
//
// Conditions (all block-level, template-agnostic):
//   1. both regions parse into valid ccxlogid blocks (no malformed/dup ids);
//   2. any content before the first marker is byte-identical;
//   3. the old id sequence is a prefix of the new id sequence (nothing
//      removed, inserted mid-sequence, or reordered — new blocks only append);
//   4. each old block is either byte-identical to its counterpart, or its
//      full text is a character-subsequence of the counterpart — i.e. the new
//      block is the old block with pure INSERTIONS only (`Model= Version=...`
//      -> `Model=claude-... Version=...`, `Tokens=` -> `Tokens=in 135, ...`,
//      empty Answer body -> filled body). Any deleted or substituted
//      character breaks the subsequence and the caller falls back to a
//      backed-up rewrite, so nothing readable in the old file can be lost.

interface IdBlockSplit {
  preamble: string[];
  blocks: { id: string; lines: string[] }[];
}

function splitIdBlocks(region: string): IdBlockSplit | null {
  const lines = region.split('\n');
  const preamble: string[] = [];
  const blocks: { id: string; lines: string[] }[] = [];
  const seen = new Set<string>();
  let current: { id: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (CCXLOG_ID_LOOSE_RE.test(line)) {
      const m = CCXLOG_ID_MARKER_RE.exec(line);
      if (!m) return null;               // malformed marker -> indeterminate
      if (seen.has(m[1])) return null;   // duplicate id -> indeterminate
      seen.add(m[1]);
      current = { id: m[1], lines: [] };
      blocks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  return { preamble, blocks };
}

// True when `oldText` is a character-subsequence of `newText`: the new text
// can be produced from the old text by insertions only. Two-pointer greedy is
// exact for the subsequence relation (no false negatives).
function isCharSubsequence(oldText: string, newText: string): boolean {
  if (oldText.length > newText.length) return false;
  let j = 0;
  for (let i = 0; i < oldText.length; i++) {
    const ch = oldText[i];
    j = newText.indexOf(ch, j);
    if (j === -1) return false;
    j++;
  }
  return true;
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Trailing blank lines of a block are inter-block / end-of-file separators,
// not content: the last block of a file ends at EOF while the same block
// followed by an appended one ends right before the next marker line, so the
// count of trailing blanks shifts without any information changing.
function trimTrailingEmpty(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end--;
  return lines.slice(0, end);
}

export function isSafeAmendment(oldRegion: string, newRegion: string): boolean {
  const ob = splitIdBlocks(oldRegion);
  const nb = splitIdBlocks(newRegion);
  if (!ob || !nb) return false;
  if (ob.blocks.length === 0) return false;              // nothing identifiable
  if (nb.blocks.length < ob.blocks.length) return false; // blocks were dropped
  if (!sameLines(ob.preamble, nb.preamble)) return false;
  for (let i = 0; i < ob.blocks.length; i++) {
    if (ob.blocks[i].id !== nb.blocks[i].id) return false; // inserted/reordered
  }
  for (let i = 0; i < ob.blocks.length; i++) {
    const o = trimTrailingEmpty(ob.blocks[i].lines);
    const n = trimTrailingEmpty(nb.blocks[i].lines);
    if (sameLines(o, n)) continue;
    if (!isCharSubsequence(o.join('\n'), n.join('\n'))) return false;
  }
  return true;
}
