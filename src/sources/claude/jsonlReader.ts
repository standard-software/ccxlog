import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { forEachLineFrom } from '../../lib/lineStream.js';
import { lazyFileSha256, sha256Hex } from '../../lib/pathUtils.js';
import type { LogEntry, Pair } from '../../lib/types.js';
import { buildStreamOpen, noteSessionTitle } from './pairBuilder.js';

// Reading a Claude Code JSONL session log, from the top or from where the last
// read stopped.
//
// Under --watch the log being written grows by a few lines at a time while it
// reaches hundreds of MB (359MB observed for one long session), and reading it
// from the top on every change cost ~2.5s a cycle. Claude Code only ever
// appends to a session log, so the analysis of the part already read can be
// kept and only the appended lines parsed (`ClaudeReadState`).
//
// The overriding invariant is the analysis cache's: a resumed read must give
// EXACTLY what a read from the top gives for the same bytes. Three things keep
// it so.
// 1. One code path. A read from the top is a resume from the empty state, so
//    the two cannot drift apart.
// 2. Pairs are kept only once CLOSED. Pair building is a state machine in
//    which every pair but the last is final once its successor opens; the state
//    holds those closed pairs plus the raw entries from the opening of the last
//    pair on, and rebuilds only that tail (see buildStreamOpen()).
// 3. A resume is attempted only on the same file (dev/ino), grown or equal in
//    size, whose first and last bytes before the resume point still hash the
//    same. Anything else — a replacement, a truncation, a rewrite at either end
//    — reads from the top. A rewrite strictly inside the already-read region
//    that keeps both ends intact is not detected; Claude Code does not write
//    logs that way, and it is the same class of limit as the cache's own
//    four-attribute identity (pathUtils.ts, FileSnapshot).

// Bytes hashed at each end of the already-read region to confirm it is intact.
const CHECK_BYTES = 64 * 1024;

interface StreamTail {
  closed: Pair[];      // final pairs, already prepared (see `prepare` below)
  open: LogEntry[];    // entries from the opening of the last pair on
}

export interface ClaudeReadState {
  dev: number;
  ino: number;
  end: number;          // bytes [0, end) were read; `end` is just past a newline
  headHash: string;
  tailHash: string;
  eventIdStream: string[];
  skipped: number;
  formatRecognized: boolean;
  titles: { aiTitle: string; customTitle: string };
  main: StreamTail;
  side: StreamTail;
}

export interface ClaudeSessionRead {
  main: Pair[];
  subagent: Pair[];
  sessionName: string;
  skippedLines: number;
  fileContentHash: () => Promise<string>;   // lazy + memoised (§6.3 complete-copy check)
  eventIdStream: string[];
  formatRecognized: boolean;   // was at least one Claude-format entry seen? (§format detection, v1.5.0)
  resumed: boolean;            // read from the previous end rather than from the top
}

// What a line contributes, kept apart from the state so the unterminated last
// line can be applied to a copy without being committed.
interface Accumulator {
  eventIdStream: string[];
  skipped: number;
  formatRecognized: boolean;
  titles: { aiTitle: string; customTitle: string };
  main: LogEntry[];
  side: LogEntry[];
}

// One line of the log. Broken lines are counted and skipped, and the rest are
// kept. The event-id stream used for logical de-duplication (§6.3) is collected
// as raw "type\0id" strings — strictPrefix compares elements for equality, so
// raw strings discriminate exactly as well as a per-element hash.
// What makes a file recognisable as a Claude session log: at least one user or
// assistant entry carrying a message. A file with none (a Codex rollout, or an
// unrelated jsonl) is left out as a source mismatch (§format detection, v1.5.0).
function addLine(acc: Accumulator, line: string): void {
  if (!line.trim()) return;
  let entry: LogEntry;
  try {
    entry = JSON.parse(line) as LogEntry;
  } catch {
    acc.skipped++;
    return;
  }
  // A value that parses but is not an object (`null`, say) still went into the
  // entry list and was then counted as skipped when reading its type threw, so
  // it is routed (and dropped by the routing) before the same check here.
  route(acc, entry);
  try {
    if ((entry.type === 'user' || entry.type === 'assistant')
      && (entry as { message?: unknown }).message) acc.formatRecognized = true;
    const uuid = (entry as { uuid?: unknown }).uuid;
    const id = typeof uuid === 'string' ? uuid : '';
    acc.eventIdStream.push(`${entry.type}\0${id}`);
  } catch {
    acc.skipped++;
    return;
  }
  noteSessionTitle(acc.titles, entry);
}

// The main conversation and the subagent (sidechain) conversation are built as
// independent streams (see buildPairsSplit() for why).
function route(acc: Accumulator, e: LogEntry): void {
  if (!e || typeof e !== 'object') return;
  ((e as { isSidechain?: unknown }).isSidechain === true ? acc.side : acc.main).push(e);
}

// Build a stream's tail. `newlyClosed` are the pairs that closed in this build;
// `openPair` is the last one, still open, if any.
function buildTail(entries: LogEntry[], sidechain: boolean): { newlyClosed: Pair[]; openPair: Pair | null; openFrom: number } {
  const { pairs, openFrom } = buildStreamOpen(entries);
  if (sidechain) for (const p of pairs) p.isSubagent = true;
  const hasOpen = openFrom < entries.length;
  return {
    newlyClosed: hasOpen ? pairs.slice(0, -1) : pairs,
    openPair: hasOpen ? pairs[pairs.length - 1] : null,
    openFrom,
  };
}

async function hashRange(fh: fs.FileHandle, start: number, end: number): Promise<string> {
  const buf = Buffer.alloc(end - start);
  let off = 0;
  while (off < buf.length) {
    const { bytesRead } = await fh.read(buf, off, buf.length - off, start + off);
    if (bytesRead === 0) break;
    off += bytesRead;
  }
  return sha256Hex(buf.subarray(0, off));
}

async function endHashes(filePath: string, end: number): Promise<{ headHash: string; tailHash: string }> {
  const fh = await fs.open(filePath, 'r');
  try {
    return {
      headHash: await hashRange(fh, 0, Math.min(end, CHECK_BYTES)),
      tailHash: await hashRange(fh, Math.max(0, end - CHECK_BYTES), end),
    };
  } finally {
    await fh.close();
  }
}

async function canResume(filePath: string, st: Stats, prev: ClaudeReadState): Promise<boolean> {
  if (st.dev !== prev.dev || st.ino !== prev.ino || st.size < prev.end) return false;
  try {
    const h = await endHashes(filePath, prev.end);
    return h.headHash === prev.headHash && h.tailHash === prev.tailHash;
  } catch {
    return false;
  }
}

/**
 * Read a Claude session log, resuming from `prev` when it still describes the
 * start of this file. `prepare` is applied once to every pair handed out (the
 * per-pair finishing steps of readSession()); closed pairs are prepared when
 * they close and kept prepared in the state.
 *
 * Returns the read and the state to resume from next time.
 */
export async function readClaudeSession(
  filePath: string,
  prepare: (pairs: Pair[]) => void,
  prev?: ClaudeReadState,
): Promise<{ read: ClaudeSessionRead; state: ClaudeReadState }> {
  const st = await fs.stat(filePath);
  const base = prev !== undefined && await canResume(filePath, st, prev) ? prev : undefined;

  const acc: Accumulator = {
    eventIdStream: base ? base.eventIdStream.slice() : [],
    skipped: base?.skipped ?? 0,
    formatRecognized: base?.formatRecognized ?? false,
    titles: { ...(base?.titles ?? { aiTitle: '', customTitle: '' }) },
    main: base ? base.main.open.slice() : [],
    side: base ? base.side.open.slice() : [],
  };
  let unterminated = null as string | null;   // set inside the callback
  const end = await forEachLineFrom(filePath, base?.end ?? 0, (line, complete) => {
    if (complete) addLine(acc, line); else unterminated = line;
  });

  // Commit the complete lines.
  const mainTail = buildTail(acc.main, false);
  const sideTail = buildTail(acc.side, true);
  prepare(mainTail.newlyClosed);
  prepare(sideTail.newlyClosed);
  const state: ClaudeReadState = {
    dev: st.dev,
    ino: st.ino,
    end,
    ...await endHashes(filePath, end),
    eventIdStream: acc.eventIdStream,
    skipped: acc.skipped,
    formatRecognized: acc.formatRecognized,
    titles: acc.titles,
    main: { closed: (base?.main.closed ?? []).concat(mainTail.newlyClosed), open: acc.main.slice(mainTail.openFrom) },
    side: { closed: (base?.side.closed ?? []).concat(sideTail.newlyClosed), open: acc.side.slice(sideTail.openFrom) },
  };

  // This read also covers a last line still being written, exactly as a read
  // from the top would, but only in what it returns: the next read starts at
  // `end` and parses that line again once it is complete.
  let mainOpen = mainTail.openPair ? [mainTail.openPair] : [];
  let sideOpen = sideTail.openPair ? [sideTail.openPair] : [];
  let view: Accumulator = acc;
  if (unterminated !== null) {
    view = {
      eventIdStream: acc.eventIdStream.slice(),
      skipped: acc.skipped,
      formatRecognized: acc.formatRecognized,
      titles: { ...acc.titles },
      main: state.main.open.slice(),
      side: state.side.open.slice(),
    };
    addLine(view, unterminated);
    mainOpen = buildStreamOpen(view.main).pairs;
    sideOpen = buildStreamOpen(view.side).pairs;
    for (const p of sideOpen) p.isSubagent = true;
  }
  prepare(mainOpen);
  prepare(sideOpen);

  return {
    read: {
      main: state.main.closed.concat(mainOpen),
      subagent: state.side.closed.concat(sideOpen),
      sessionName: view.titles.customTitle || view.titles.aiTitle,
      skippedLines: view.skipped,
      fileContentHash: lazyFileSha256(filePath, { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino }),
      eventIdStream: view.eventIdStream,
      formatRecognized: view.formatRecognized,
      resumed: base !== undefined,
    },
    state,
  };
}
