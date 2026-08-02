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
