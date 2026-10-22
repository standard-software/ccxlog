import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// Stream a file line by line (§12.3: never hold the whole file as one string or
// as an array of all lines). `onLine` receives each newline-delimited line
// without its terminator (equivalent to split('\n'); a trailing empty line is
// not passed).
//
// Performance notes (measured in R1 on ~350MB of real WSL logs):
// - The read chunk is 8MB. With the default 64KB highWaterMark, 350MB produced
//   roughly 5,500 'data' events, and the per-event overhead plus the
//   read/process handoff alone doubled wall-clock time (4.9s -> 2.2s). Even at
//   8MB only one chunk is held at a time, so the "never hold the whole file"
//   bound still stands.
// - Lines are cut with a single split('\n') per chunk. The old implementation
//   re-sliced the remaining buffer for every line (buf = buf.slice(nl+1)),
//   copying the whole remainder each time, which made the cost quadratic within
//   a chunk (CPU profiling showed ~1.4s in the slice loop plus ~0.5s of GC).
//   The split version is linear in chunk length.
// - Multi-byte characters split across a chunk boundary are absorbed by
//   StringDecoder (a UTF-8 sequence spanning the boundary is rejoined with the
//   next chunk).
// - The whole-file SHA-256 the old implementation computed during reading is now
//   lazy: it is used only by the §6.3 duplicate check and almost never fires
//   (see lazyFileSha256 in pathUtils).
//
// This is exported because the chunk-boundary test
// (tests/speedupGuards.test.mjs) reads the value. Duplicating it in the test
// would let a future change here silently move the boundary the test exercises.
export const READ_CHUNK_BYTES = 8 * 1024 * 1024;

// Stream the lines of a file starting at byte offset `start` (which must be 0
// or just past a newline), for readers that resume where they left off. Each
// line is reported with `complete`: true when its newline was read, false for
// an unterminated last line (a line still being written). The return value is
// the byte offset just past the last newline read — the point a later call can
// resume from without re-reading or splitting a line.
//
// Lines are cut on the newline BYTE before decoding. 0x0A never occurs inside
// a multi-byte UTF-8 sequence, so every cut is also a character boundary and
// decoding each line on its own yields exactly what forEachLine()'s streaming
// decoder yields for the same bytes. That equivalence is what lets a resumed
// read and a read from the top produce the same lines.
export async function forEachLineFrom(
  filePath: string,
  start: number,
  onLine: (line: string, complete: boolean) => void,
): Promise<number> {
  let rest: Buffer = Buffer.alloc(0);
  let end = start;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { start, highWaterMark: READ_CHUNK_BYTES });
    stream.on('data', (chunk: string | Buffer) => {
      const b: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const buf = rest.length > 0 ? Buffer.concat([rest, b]) : b;
      const nl = buf.lastIndexOf(0x0a);
      if (nl === -1) { rest = buf; return; }   // no complete line yet
      rest = buf.subarray(nl + 1);
      end += nl + 1;
      for (const part of buf.toString('utf8', 0, nl).split('\n')) onLine(part, true);
    });
    stream.on('end', () => {
      if (rest.length > 0) onLine(rest.toString('utf8'), false);
      resolve();
    });
    stream.on('error', reject);
  });
  return end;
}

// Reading stops and the promise resolves as soon as `onLine` returns false
// (used by the Codex prefilter's early return). Existing callers that return
// void (undefined) still process every line.
export async function forEachLine(
  filePath: string,
  onLine: (line: string) => void | boolean,
): Promise<void> {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { highWaterMark: READ_CHUNK_BYTES });
    // `settled` centralises resolve/reject so that an 'error' arriving after an
    // early-stop destroy(), or a reject after we already resolved, is reliably
    // ignored.
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.on('data', (chunk: string | Buffer) => {
      const b: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      buf += decoder.write(b);
      if (buf.indexOf('\n') === -1) return;   // no complete line yet
      const parts = buf.split('\n');
      buf = parts.pop() as string;            // the tail is an unfinished line, carried to the next chunk
      for (const part of parts) {
        if ((onLine(part) as boolean | undefined) === false) {
          stream.destroy();
          finish();
          return;
        }
      }
    });
    stream.on('end', () => {
      buf += decoder.end();
      if (buf.length > 0) onLine(buf);
      finish();
    });
    stream.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}
