import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

// Stream a file line by line WITHOUT holding the whole file as a single string
// or a full array of lines (§12.3). A running SHA-256 over the raw bytes gives
// the byte-exact file-content hash; `onLine` receives each newline-delimited
// line with the terminator stripped (equivalent to split('\n'), trailing
// empty line omitted). Returns the file-content hash (hex).
export async function forEachLine(
  filePath: string,
  onLine: (line: string) => void,
): Promise<string> {
  const hash = crypto.createHash('sha256');
  const decoder = new StringDecoder('utf8');
  let buf = '';
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => {
      const b: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      hash.update(b);
      buf += decoder.write(b);
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    });
    stream.on('end', () => {
      buf += decoder.end();
      if (buf.length > 0) onLine(buf);
      resolve();
    });
    stream.on('error', reject);
  });
  return hash.digest('hex');
}
