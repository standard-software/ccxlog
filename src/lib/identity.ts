import { sha256Hex, sha256HexBytes } from './pathUtils.js';
import type { UnifiedPair } from './types.js';

// ---- ccxlogId (answer-independent stable id, hex 24 / 96-bit) — §9.2 -----

function questionKeyOf(u: UnifiedPair): string {
  return u.questionEventUuid && u.questionEventUuid.length
    ? u.questionEventUuid
    : sha256Hex(u.question);
}

// Assign collisionOrdinal within each (source, sessionId, questionTimestampRaw,
// subagent?) group, then compute the ccxlogId. Mutates each pair's internal
// `ccxid` field.
//
// The subagent flag is part of the GROUP key but NOT of the id material, and it
// is there for one reason: turning `includeSubagents` on must add blocks and
// change none (spec §5.2, §13). A Claude session log holds its subagent
// conversation inline, so without the split a sidechain question recorded in the
// same millisecond as an ordinary one would join that one's collision group and
// shift its ordinal — silently moving the ccxlogid of a block that has nothing
// to do with subagents. Keeping the two sets of groups apart makes the ordinals
// of the ordinary blocks depend only on the ordinary blocks, exactly as they did
// before the option existed. Codex is unaffected either way: there a subagent is
// always a separate session, so its pairs never shared a group to begin with.
export function assignCcxids(pairs: UnifiedPair[]): void {
  const groups = new Map<string, UnifiedPair[]>();
  for (const p of pairs) {
    const key = `${p.source}\0${p.sessionId}\0${p.questionTimestampRaw}\0${p.isSubagent ? 'sub' : ''}`;
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

const CCXLOG_ID_MARKER_RE = /^<!-- (ccxlogid:[0-9a-f]{24})(?: time:(\d+|unknown))? -->$/;
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

// The ids present in the old content and missing from the new one, in the order
// the old content lists them, each reported once. Empty for method 'none' — not
// because nothing is being lost there, but because an undecidable comparison
// cannot name what it loses; isDestructive treats that case separately.
function blockTimes(content: string): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const lines = content.split('\n');
  let currentId: string | null = null;
  for (const line of lines) {
    const id = CCXLOG_ID_MARKER_RE.exec(line);
    if (id) {
      currentId = id[1];
      result.set(currentId, id[2] && id[2] !== 'unknown' ? Number(id[2]) : null);
      continue;
    }
    if (!currentId) continue;
    // Backward compatibility for Markdown generated before the time field was
    // added to the formal marker. A custom old template without DateTime is
    // indeterminate and remains protected by the conservative backup path.
    const legacy = /^# (\d{4})\/(\d{2})\/(\d{2}) \w{3} (\d{2}):(\d{2}):(\d{2})(?:\s|$)/.exec(line);
    if (legacy && result.get(currentId) === null) {
      result.set(currentId, new Date(
        Number(legacy[1]), Number(legacy[2]) - 1, Number(legacy[3]),
        Number(legacy[4]), Number(legacy[5]), Number(legacy[6]),
      ).getTime());
    }
  }
  return result;
}

export function lostIds(
  oldContent: string,
  newContent: string,
  method: BlockMethod,
  ignoreSinceMs?: number,
  ignoreThroughMs?: number,
): string[] {
  if (method === 'none') return [];
  const newIds = new Set(idsByMethod(newContent, method));
  const cutoff = ignoreSinceMs ?? null;
  const times = cutoff === null ? null : blockTimes(oldContent);
  const seen = new Set<string>();
  const lost: string[] = [];
  for (const id of idsByMethod(oldContent, method)) {
    if (newIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    const timestamp = times?.get(id);
    if (timestamp !== undefined && timestamp !== null && cutoff !== null
      && timestamp >= cutoff && (ignoreThroughMs === undefined || timestamp <= ignoreThroughMs)) continue;
    lost.push(id);
  }
  return lost;
}

// A destructive rewrite = at least one block id present in the old content is
// missing from the new content. That is the ONLY trigger for an automatic backup
// (v1.4.0 R2). Method 'none' (no valid id in the old content, malformed ids,
// duplicate ids, or a failed parse of the new side) cannot be decided, so it is
// treated as destructive — the safe direction — and a backup is taken. As long
// as every id survives, replacing body text, inserting in the middle,
// reordering, and changing the template all count as non-destructive.
//
// Built on lostIds rather than repeating the comparison, so the backup decision
// and the reason recorded beside the backup (backup.ts) can never disagree —
// "backed up but nothing listed as lost" would send a user hunting for a loss
// that the two implementations merely described differently.
export function isDestructive(
  oldContent: string,
  newContent: string,
  method: BlockMethod,
  ignoreSinceMs?: number,
  ignoreThroughMs?: number,
): boolean {
  if (method === 'none') return true; // undecidable -> back up, the safe direction
  return lostIds(oldContent, newContent, method, ignoreSinceMs, ignoreThroughMs).length > 0;
}

// The first non-empty line after each wanted id's marker, which is what makes a
// lost block recognisable at a glance (the heading a template renders: date,
// source, session). Nothing is assumed about that line's shape — templates are
// user-editable — so whatever follows the marker is what gets reported.
//
// One pass over the content for all ids together: the caller may ask about
// hundreds of blocks in a file of tens of megabytes.
export function blockLabels(content: string, ids: string[]): Map<string, string> {
  const wanted = new Set(ids);
  const labels = new Map<string, string>();
  if (wanted.size === 0) return labels;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && labels.size < wanted.size; i++) {
    const m = CCXLOG_ID_MARKER_RE.exec(lines[i]);
    if (!m || !wanted.has(m[1]) || labels.has(m[1])) continue;
    let label = '';
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (candidate === '') continue;
      if (CCXLOG_ID_MARKER_RE.test(lines[j])) break; // next block starts: this one has no body
      label = candidate;
      break;
    }
    labels.set(m[1], truncateChars(label, 160));
  }
  return labels;
}

// Cut by code point, never mid character: the label is copied verbatim from a
// conversation and routinely holds Japanese, emoji and other astral characters.
function truncateChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max).join('')}...`;
}
