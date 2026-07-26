import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function sha256HexBytes(input: string | Buffer, digits: number): string {
  return sha256Hex(input).slice(0, digits);
}

// 解析時点のファイル状態。遅延ハッシュとプリフィルタの「同一ファイルの
// まま変わっていないか」照合に使う。size/mtime に加えて dev/ino を持つ:
// size/mtime だけでは「同サイズ・mtime 保存付きの別内容ファイルでの置換」
// （cp -p 相当の rename 置換や、mtime 粒度の粗いファイルシステムでの同サイズ
// 書換）を検出できず、解析した内容と異なる内容のハッシュで重複を確定して
// 正当なペアを削除し得る（R2 レポート指摘。データを失う側に倒れる唯一の
// 残存経路だった）。dev/ino を含めれば rename 置換で実体が変わったことを
// 検出できる（ino が取れないファイルシステムでは 0 同士の比較になり
// size/mtime のみと同等へ自然に縮退する）。
// 既知の限界（理論経路）: 同一 inode のまま同サイズで内容を書き換え、かつ
// mtime を元の値へ復元する in-place 改変は、この4属性照合では検出できない。
// 完全に塞ぐには照合のたびに内容指紋（部分ハッシュ等）の再読みが必要で、
// 「滅多に発火しない経路以外ではファイルを読まない」という本高速化の前提を
// 崩すため採らない。通常のログ書き込み（追記）では発生せず、mtime を意図的に
// 復元する外部操作が要る（設計判断。SPEEDUP-NOTES §7 にも記載）。
export interface FileSnapshot {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export async function fileSnapshot(filePath: string): Promise<FileSnapshot | null> {
  try {
    const st = await fs.stat(filePath);
    return { size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

export function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.dev === b.dev && a.ino === b.ino;
}

// 遅延ハッシュのストリーム読みチャンク。既定の 64KB は R1 で「遅い」ことを
// 実証済みの値なので、ハッシュ経路にも大きめのチャンクを明示する（滅多に
// 発火しない経路だが、読込パスの知見と不整合を残さない。R2 レポート指摘）。
export const HASH_READ_CHUNK_BYTES = 1024 * 1024;

// 遅延・メモ化された全ファイル SHA-256（§6.3 重複確認「ファイル全体の完全
// コピー」用）。このハッシュは「候補キーが一致し、かつ安価な確認では決着
// しなかった」ペアでのみ必要になる＝実運用ではほぼ発火しないため、通常の
// 読込パスでは計算しない（旧実装は毎回、全ログバイトを読込と同時にハッシュ
// していた）。
// - 計算は非同期ストリーミング。readFileSync の一括読みはファイル全体を
//   メモリへ載せ（350MB 級で §12.3 の設計方針に反する）、イベントループも
//   止めるため不採用（R1 両レポートの指摘）。
// - TOCTOU 対策: 解析時に取得した snapshot（size/mtime/dev/ino）と、ハッシュ
//   計算の直前・直後の stat を照合する。解析後に変更・置換されたファイル
//   （ハッシュ計算中の追記を含む）は '' を返し「重複と確認しない」。これは
//   従来の「ハッシュ無し」と同じ保守的挙動で、両方残す側に倒れる。
// - 読めないファイルも同様に ''（= 重複と確認しない）。
export function lazyFileSha256(filePath: string, expected: FileSnapshot): () => Promise<string> {
  let memo: Promise<string> | null = null;
  return () => (memo ??= hashFileGuarded(filePath, expected));
}

async function hashFileGuarded(filePath: string, expected: FileSnapshot): Promise<string> {
  try {
    const before = await fileSnapshot(filePath);
    if (!before || !sameSnapshot(before, expected)) return '';
    const hash = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { highWaterMark: HASH_READ_CHUNK_BYTES });
      stream.on('data', (chunk: string | Buffer) => {
        hash.update(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const after = await fileSnapshot(filePath);
    if (!after || !sameSnapshot(after, expected)) return '';
    return hash.digest('hex');
  } catch {
    return '';
  }
}

// Claude Code's project-directory encoding: EVERY character outside
// [a-zA-Z0-9] becomes '-' (not just path separators). '_' '.' spaces and
// non-ASCII all collapse to '-'.
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

export function getClaudeLogDirForProject(cwd: string): string {
  return path.join(getClaudeProjectsDir(), encodeCwd(cwd));
}

export function getCodexSessionsDir(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

// canonicalPath (§5.4): resolve -> realpath (best effort) -> normalize ->
// win32-only lowercase. Cached because the same cwds repeat across pairs.
const canonicalCache = new Map<string, string>();
export async function canonicalPath(p: string): Promise<string> {
  const key = path.resolve(p);
  const hit = canonicalCache.get(key);
  if (hit !== undefined) return hit;
  let real: string;
  try {
    real = await fs.realpath(key);
  } catch {
    real = key;
  }
  let canon = path.normalize(real);
  if (process.platform === 'win32') canon = canon.toLowerCase();
  canonicalCache.set(key, canon);
  return canon;
}

// String canonicalization without touching the filesystem (for non-existent
// paths / stableRootKey). resolve -> normalize -> win32 lowercase.
export function canonicalPathString(p: string): string {
  let canon = path.normalize(path.resolve(p));
  if (process.platform === 'win32') canon = canon.toLowerCase();
  return canon;
}

export function isPathWithin(filePath: string, rootPath: string): boolean {
  if (filePath === rootPath) return true;
  const prefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  return filePath.startsWith(prefix);
}

// Physical-file identity key: dev+ino when available, else canonical path.
export interface FileIdentity {
  key: string;
  size: number;
  mtimeMs: number;
}

export async function fileIdentity(filePath: string): Promise<FileIdentity | null> {
  try {
    const st = await fs.stat(filePath);
    const key = st.ino !== 0 ? `dev:${st.dev}:ino:${st.ino}` : canonicalPathString(filePath);
    return { key, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// Namespaced sourceFileRelativeId (§5.5):
//   <source>/<standard|extra>/<stableRootKey>/<relativePath>
export function buildRelativeId(
  source: 'claude' | 'codex',
  origin: 'standard' | 'extra',
  stableRootKey: string,
  rootDir: string,
  filePath: string,
): string {
  const rel = path.relative(rootDir, filePath).split(path.sep).join('/');
  return `${source}/${origin}/${stableRootKey}/${rel}`;
}
