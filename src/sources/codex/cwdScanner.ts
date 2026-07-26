import { forEachLine } from '../../lib/lineStream.js';
import {
  canonicalPath, canonicalPathString, fileSnapshot, isPathWithin, sameSnapshot,
} from '../../lib/pathUtils.js';
import { extractCodexCwdRecord } from './jsonlReader.js';
import type { DiscoveredFile, FilterContext } from '../adapter.js';

const PREFILTER_CONCURRENCY = 8;

// Codex cwd プリフィルタ（R1 cx1 の構造的最適化を R2 で安全化・統合し、
// R3 で両系統の安全策を合流、R4 で走査と判定の責務を分離した最終形）。
//
// Codex は全プロジェクトのログを共有ツリー（~/.codex/sessions）に混在させる
// ため、従来は無関係プロジェクトのファイルまで全パースしていた。ここでは
// cwd を持つ行（session_meta / turn_context）だけを軽く走査し、「この
// プロジェクトに属し得ない」ファイルを全パース前に除外する。
//
// 構造: 走査（scanCodexCwds → CwdScanResult）と判定（mayBelong）を分離する。
// mayBelong へは scanner を注入できる（既定は scanCodexCwds）。注入は
// テスト容易性のため（走査失敗や「走査完了〜走査後照合」間の追記を、実走査を
// 保ったまま決定的に再現できる）。特定タイミングのフックは本番 API に置かない。
//
// 安全設計（除外して良いのは「確実に属さない」ファイルだけ）:
// - 明示 extraLogDirs 配下は既存契約どおり無条件で残す（§5.2）。
// - cwd 抽出は通常リーダーと共有の extractCodexCwdRecord() を使う（形式知識の
//   一元化。将来の形式変更で片方だけ更新される事故を防ぐ）。
// - cwd を1つも持たないファイルは除外せず「通常解析へフォールバック」する
//   （挙動はプリフィルタ導入前と完全一致に保たれる）。
// - 未知レコード型が payload.cwd らしき文字列を持っていた場合も除外しない
//   （unknownFormat ガード）。将来 Codex が cwd を持つ新レコード型を導入した
//   時、その cwd がここで認識できなくても「除外」側へ倒れない。
//   既知の限界: cwd が payload 直下以外（レコードのトップレベルや深い入れ子
//   等）に置かれた未知形式はこのガードでも検出できない。その場合でも、当該
//   ファイルに既知形式の cwd が1つも無ければ「cwd 未観測」としてフォール
//   バックされるため、既知形式の無関係 cwd と未知形式の対象 cwd が同居する
//   ファイルだけが理論上の残存リスクになる。
// - 走査が I/O エラー等で失敗したファイルも除外せず通常解析へフォールバック
//   する（一時的な読み取り失敗でセッションが出力から消えたり、プリフィルタ段
//   で CLI 全体が落ちたりしない）。
// - 走査の前後で snapshot（size/mtime/dev/ino）を照合し、走査中に追記・置換
//   されたファイルは除外せず通常解析へフォールバックする（ライブ追記の窓:
//   無関係 cwd だけを読んだ直後に対象 cwd のターンが追記されるケースを救済）。
//   既知の限界: 同一 inode のまま同サイズで書き換え、かつ mtime を元の値へ
//   復元する in-place 改変は snapshot 照合では検出できない（4属性がすべて
//   一致してしまう理論経路）。塞ぐには走査対象バイト列の指紋比較等が必要で、
//   全ファイルの追加読みは本プリフィルタの高速化効果を打ち消すため採らない。
//   通常のログ書き込み（追記）でこの改変は発生せず、発生させるには mtime を
//   意図的に復元する外部操作が要る（設計判断。SPEEDUP-NOTES §7 にも記載）。
// - 走査は高速化済みの共通リーダー forEachLine（8MB チャンク）を使い、属する
//   cwd を見つけた時点で読み込みを中断する（early-return。対象プロジェクト
//   自身のファイルは大抵1行目の session_meta で確定するため、「属する
//   ファイルの二度読み」がほぼ消える）。

// realpath を伴う正式判定（filterSession の wanted() と同一ロジック）。
async function cwdBelongs(rawCwd: string, ctx: FilterContext): Promise<boolean> {
  const canon = await canonicalPath(rawCwd);
  if (ctx.wantedCwds.has(canon)) return true;
  return ctx.includeSubdirectories && isPathWithin(canon, ctx.canonicalProjectPath);
}

// realpath を伴わない同期の予備判定。true なら「属する」と即断して走査を
// 打ち切ってよい（残す側の誤検出は無害 — 後段の filterSession が最終判定
// する）。false でも除外はせず、走査完了後に cwdBelongs（realpath あり）で
// 精密に再判定する。シンボリックリンク等で文字列表現が食い違うケースは
// この再判定側が拾う。
function quickBelongs(rawCwd: string, ctx: FilterContext): boolean {
  const canon = canonicalPathString(rawCwd);
  if (ctx.wantedCwds.has(canon)) return true;
  return ctx.includeSubdirectories && isPathWithin(canon, ctx.canonicalProjectPath);
}

// 走査結果の明示的な境界。mayBelong の判定材料はこの4値で全部。
// - cwds: 観測した cwd（既知形式のレコード由来のみ。matchedFast 時は途中まで）
// - recognized: 既知形式のレコード（session_meta / turn_context）を観測したか
//   （本番の残す/除外の判定は cwds の有無と unknownFormat で行う。recognized は
//    テスト・診断用の観測情報で、判定には現在使っていない）
// - unknownFormat: 未知レコード型が payload.cwd らしき文字列を持っていたか
// - matchedFast: quickBelongs で「属する」と即断し走査を打ち切ったか
export interface CwdScanResult {
  cwds: string[];
  recognized: boolean;
  unknownFormat: boolean;
  matchedFast: boolean;
}

// 1ファイルを軽量走査して cwd 情報だけを集める（残す/除外の判定はしない）。
// 通常リーダーと同じ forEachLine・同じ形式知識（extractCodexCwdRecord）を使う。
// I/O エラーはそのまま呼び出し側へ伝播させる（ここでは握り潰さない。
// フォールバック判断は mayBelong の責務）。
export async function scanCodexCwds(
  filePath: string,
  ctx: FilterContext,
): Promise<CwdScanResult> {
  const cwds = new Set<string>();
  let recognized = false;
  let unknownFormat = false;
  let matchedFast = false;
  await forEachLine(filePath, (line) => {
    // 大半の行は cwd を持たない。部分文字列ゲートで JSON.parse を回避する
    // （cwd キーを持つ JSON 行は必ず '"cwd"' を含む）。
    if (!line.includes('"cwd"')) return;
    let event: unknown;
    try { event = JSON.parse(line); } catch { return; }
    const record = extractCodexCwdRecord(event);
    if (!record.recognized) {
      // 未知レコード型に payload.cwd らしき文字列 → 将来形式の可能性が
      // あるため「除外して良い根拠」を放棄する（unknownFormat ガード）。
      const payload = (event as Record<string, unknown>).payload;
      if (payload && typeof payload === 'object'
        && typeof (payload as Record<string, unknown>).cwd === 'string') {
        unknownFormat = true;
      }
      return;
    }
    recognized = true;
    if (!record.cwd) return;
    if (quickBelongs(record.cwd, ctx)) {
      matchedFast = true;
      return false;   // early-return: 属すると確定したので残りは読まない
    }
    cwds.add(record.cwd);
    return;
  });
  return { cwds: [...cwds], recognized, unknownFormat, matchedFast };
}

export type CwdScanner = typeof scanCodexCwds;

// 1ファイルがこのプロジェクトに属し得るか。false を返して良いのは
// 「cwd を1つ以上観測し、そのどれもがプロジェクトに属さず、かつ走査中に
// ファイルが変化していない」場合だけ。
// scanner は注入可能（既定 = scanCodexCwds）。テストは実走査を包むラッパーを
// 渡すことで、走査失敗や「実走査完了〜走査後照合」間の追記を実経路のまま
// 決定的に再現できる。
export async function mayBelong(
  file: DiscoveredFile,
  ctx: FilterContext,
  scanner: CwdScanner = scanCodexCwds,
): Promise<boolean> {
  // 明示ルートは cwd を見ずに必ず残す（§5.2 の信頼契約）。
  if (file.root.origin === 'extra') return true;
  // 走査前 snapshot。取れないファイル（走査直前に消えた等）は判定せず残す
  // （通常解析側が従来どおりのエラー処理をする）。
  const before = await fileSnapshot(file.filePath);
  if (!before) return true;
  let scan: CwdScanResult;
  try {
    scan = await scanner(file.filePath, ctx);
  } catch {
    // 走査失敗（I/O エラー等）→ 除外せず通常解析へフォールバック。
    // ここで catch しないと Promise.all 経由で CLI 全体が異常終了する。
    return true;
  }
  if (scan.matchedFast) return true;
  // 走査後 snapshot 照合: 走査中に追記・置換されたファイルは、走査結果
  // （無関係 cwd しか見ていない）が既に古い可能性があるため除外しない。
  // matchedFast の early-return 側は「残す」判定なので照合不要。
  const after = await fileSnapshot(file.filePath);
  if (!after || !sameSnapshot(before, after)) return true;
  // cwd が1つも無い（未知形式を含む）→ 除外せず通常解析へフォールバック。
  // 従来パスでも属否判定は cwd に依存するため、挙動は導入前と一致する。
  if (scan.unknownFormat || scan.cwds.length === 0) return true;
  for (const cwd of scan.cwds) {
    if (await cwdBelongs(cwd, ctx)) return true;
  }
  return false;
}

// 並列度を制限してファイルシステム読みを重ね合わせる（無制限にファイルを
// 開かない）。結果は index 書き込みで発見順を維持し、下流の決定的な出力
// 順序を保つ。
export async function prefilterCodexFiles(
  files: DiscoveredFile[],
  ctx: FilterContext,
): Promise<DiscoveredFile[]> {
  // 初期値は「残す」側（true）。worker が全 index を埋めるため通常は必ず
  // 上書きされるが、万一の未設定時にも除外側へ倒れない既定にしておく。
  const keep = new Array<boolean>(files.length).fill(true);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= files.length) return;
      keep[index] = await mayBelong(files[index], ctx);
    }
  };
  const count = Math.min(PREFILTER_CONCURRENCY, files.length);
  await Promise.all(Array.from({ length: count }, () => worker()));
  return files.filter((_, index) => keep[index]);
}
