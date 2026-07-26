import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// ファイルを1行ずつストリーム処理する（§12.3: ファイル全体を1つの文字列や
// 全行配列として保持しない）。`onLine` は改行区切りの各行を終端文字なしで
// 受け取る（split('\n') 相当。末尾の空行は渡さない）。
//
// 性能メモ（R1 実測: WSL 実ログ約350MB）:
// - 読み込みチャンクは 8MB。既定の 64KB highWaterMark では 350MB あたり
//   約5,500回の 'data' イベントが発生し、イベント毎のオーバーヘッドと
//   読み込み/処理の待ち合わせだけで実時間が約2倍になっていた
//   （4.9s→2.2s に改善）。8MB でも保持するのはチャンク単位のみで、
//   「ファイル全体は保持しない」という上限は保たれる。
// - 行の切り出しはチャンク毎に1回の split('\n')。旧実装は1行ごとに残り
//   バッファを slice し直して（buf = buf.slice(nl+1)）残り全体をコピー
//   していたため、チャンク内で二次関数的なコストになっていた（CPU
//   プロファイルで slice ループ約1.4s + GC 約0.5s を確認）。split 版は
//   チャンク長に対して線形。
// - マルチバイト文字のチャンク境界分断は StringDecoder が吸収する
//   （境界をまたぐ UTF-8 シーケンスは次チャンクと連結して復元される）。
// - 旧実装が読み込みと同時に計算していた全ファイル SHA-256 は、§6.3 の
//   重複確認でしか使われず滅多に発火しないため遅延化した
//   （pathUtils の lazyFileSha256 を参照）。
//
// export しているのはチャンク境界テスト（tests/speedupGuards.test.mjs）が
// この値を参照するため。テスト側に複製すると、将来ここを変えた時に境界
// テストが黙って別の境界を試験するようになる（R2 レポート指摘）。
export const READ_CHUNK_BYTES = 8 * 1024 * 1024;

// `onLine` が false を返した時点で読み込みを中断して resolve する
// （Codex プリフィルタの early-return 用）。void（undefined）を返す
// 既存の呼び出し側は従来どおり全行を処理する。
export async function forEachLine(
  filePath: string,
  onLine: (line: string) => void | boolean,
): Promise<void> {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { highWaterMark: READ_CHUNK_BYTES });
    // settled で resolve/reject を一元管理する（early-stop の destroy() 後に
    // 届く 'error'、resolve 済み後の reject を確実に無視する）。
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.on('data', (chunk: string | Buffer) => {
      const b: Buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      buf += decoder.write(b);
      if (buf.indexOf('\n') === -1) return;   // 完全な行がまだ無い
      const parts = buf.split('\n');
      buf = parts.pop() as string;            // 末尾要素は未完の行（次チャンクへ持ち越し）
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
