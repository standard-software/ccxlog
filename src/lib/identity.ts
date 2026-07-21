import { sha256Hex, sha256HexBytes } from './pathUtils.js';
import type { UnifiedPair } from './types.js';

// ---- ccxid (answer-independent stable id, hex 24 / 96-bit) — §9.2 --------

function questionKeyOf(u: UnifiedPair): string {
  return u.questionEventUuid && u.questionEventUuid.length
    ? u.questionEventUuid
    : sha256Hex(u.question);
}

// Assign collisionOrdinal within each (source, sessionId, questionTimestampRaw)
// group, then compute the ccxid. Mutates each pair's `ccxid` field.
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
      p.ccxid = `ccxid:${sha256HexBytes(material, 24)}`;
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

export type BlockMethod = 'ccxid' | 'datetime' | 'none';

const CCXID_MARKER_RE = /^<!-- ccxlog-pair:(ccxid:[0-9a-f]{24}) -->$/;
const CCXID_LOOSE_RE = /^<!-- ccxlog-pair:/;
const DATETIME_ID_RE = /^# \d{4}\/\d{2}\/\d{2} \w{3} \d{2}:\d{2}:\d{2}/;

export interface CcxidParse {
  count: number;
  ids: string[];
  valid: boolean;          // no duplicate ids and no malformed ccxlog-pair lines
  firstLineIndex: number;  // -1 if none
}

export function parseCcxid(content: string): CcxidParse {
  const lines = content.split('\n');
  const ids: string[] = [];
  let invalid = false;
  let firstLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!CCXID_LOOSE_RE.test(line)) continue;
    const m = CCXID_MARKER_RE.exec(line);
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

export interface DatetimeParse {
  count: number;
  ids: string[];
  firstLineIndex: number;
}

export function parseDatetime(content: string): DatetimeParse {
  const lines = content.split('\n');
  const ids: string[] = [];
  let firstLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = DATETIME_ID_RE.exec(lines[i]);
    if (m) {
      if (firstLineIndex === -1) firstLineIndex = i;
      ids.push(m[0]);
    }
  }
  return { count: ids.length, ids, firstLineIndex };
}

// Choose the comparison method between two document bodies (§9.1).
export function chooseMethod(oldContent: string, newContent: string): {
  method: BlockMethod;
  oldFirstLine: number;
  newFirstLine: number;
} {
  const oc = parseCcxid(oldContent);
  const nc = parseCcxid(newContent);
  if (oc.count > 0 && nc.count > 0 && oc.valid && nc.valid) {
    return { method: 'ccxid', oldFirstLine: oc.firstLineIndex, newFirstLine: nc.firstLineIndex };
  }
  const od = parseDatetime(oldContent);
  const nd = parseDatetime(newContent);
  if (od.count > 0 && nd.count > 0) {
    return { method: 'datetime', oldFirstLine: od.firstLineIndex, newFirstLine: nd.firstLineIndex };
  }
  return { method: 'none', oldFirstLine: -1, newFirstLine: -1 };
}

// Substring from the given line index to EOF (byte-exact for LF content).
export function regionFromLine(content: string, lineIndex: number): string {
  if (lineIndex < 0) return content;
  return content.split('\n').slice(lineIndex).join('\n');
}

export function idsByMethod(content: string, method: BlockMethod): string[] {
  if (method === 'ccxid') return parseCcxid(content).ids;
  if (method === 'datetime') return parseDatetime(content).ids;
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
