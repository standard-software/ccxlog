# ccxlog

**Language:** [English/英語](VERSION.md)

## Version

### 1.7.0
#### 2026/08/06(木)
- Codex サブエージェントの rollout に再収録された親の会話が、新しい投稿として
  重複表示される問題を、実際のサブエージェントへの指示と回答を保持したまま修正
- Codex サブエージェントに自身のスレッド ID・名前を使用し、親から継承した
  トークン基準値を使用量から除外するよう修正

### 1.6.0
#### 2026/08/03(月)
- 継続更新する `--watch` を追加。`--watch=8h` の時間指定と、
  `watchIntervalSeconds` による待機時間の設定に対応
- 変化のないログの再利用と、テンプレートで使わない進捗データの保持削減により、
  watch の処理速度とメモリ使用量を改善
- 書き込み時の出力先ロックを自動化。watch は停止までロックを保持し、同じ出力先への
  他の ccxlog 実行による書き込みを防止
- Codex の `/rename` で設定した名前を `%SessionName%` に反映

### 1.5.0
#### 2026/07/29(火)
- `claude.includeSidechain: true` で、新しめの Claude Code が
  `<セッションID>/subagents/*.jsonl` として別ファイルに保存するサブエージェント
  記録も探索し、追加セッションとして描画（cclog との機能差を解消）
- 探索の一括除外（`<out>` 配下、および `backup_jsonl` / `backup_CCXLOG_md` /
  `templates` という名前のフォルダ）を撤廃。明示指定した `extraLogDirs` は
  指した場所をそのまま読むため、`<out>/backup_jsonl` のスナップショットを
  cclog 流に読み戻せる
- 各ソースは自分の形式のファイルだけを取り込む（claude は Codex rollout を、
  codex は Claude ログを読み飛ばし、無関係な `.jsonl` は両方が読み飛ばす）。
  cc/cx が混在するバックアップを両ソースの `extraLogDirs` に指定できる
- `--backup-jsonl` はルートからの相対構造を保存（`cc/` はライブ配置のミラーで
  `subagents/` は設定に関わらず常にバックアップ、`cx/` は日付ツリーを保存）。
  コピー先配下の既存ファイルは再コピーしないので自己増殖せず、
  スナップショットは本物のログフォルダと同じように読み戻せる
- 自動バックアップの保存先を手動 `--backup-md` と別の
  `backup_CCXLOG_md_auto/` に分離（ここに増えたら「ペアが消えようとした」
  シグナル）

### 1.4.0
#### 2026/07/27(月)
- 回答が始まる前にキャンセルして打ち直した Claude の質問を、置き換えて消す
  のではなく回答なしの独立ペアとして残す（実測で質問の2〜5%がこの形で
  消えていた）。追い打ちメッセージの統合・ペア確定・既存 `ccxlogid`・
  Codex 出力はすべて不変
- 自動バックアップを「ペア消失事故を防ぐ最後の砦」に再定義：書き換え前に
  あった `ccxlogid` が新内容から1つでも失われる場合、または安全に判定
  できない場合のみ実行。ID がすべて保たれる書き換え（回答差し替え・
  テンプレート変更・挿入・並べ替え）ではバックアップしない。手動
  `--backup-md` / `--backup-jsonl` は不変
- v1.3.0 の `amend` 機構を撤去（ID ベースの判定に置き換え）

### 1.3.0
#### 2026/07/27(日)
- ログ読み込みを大幅高速化（実データで統合モード約35〜45%短縮・大規模ログで
  最大約2.4倍。`-cc` は cclog と同等速度）：8 MiB チャンク読み・重複確認
  ハッシュの遅延非同期化（size/mtime/dev/ino 照合付き）・`%Progress%` の
  遅延生成
- Codex の cwd を事前走査し、他プロジェクトのセッションの全文解析を省略
  （実データで 92→9 ファイル）。未知形式・cwd 不明・I/O エラー・走査中の
  変更は安全側で全文解析にフォールバック。`--verbose` で `fully read` を表示
- 3モードとも出力は 1.2.0 とバイト単位で同一
- 情報が失われないと証明できる書き換え（`amend`）はバックアップを省略し、
  常時セッションが動くプロジェクトで毎回バックアップが積まれる問題を解消

### 1.2.0
#### 2026/07/23(木)
- ソース選択を `-cc` / `-cx` に簡素化（`--claude-only` / `--codex-only` /
  `--source` を廃止）
- 全面書き換えの前に既存の出力 Markdown をバックアップ（変更なし・純粋な
  末尾追記は除く。テンプレートのみの変更や過去 Q&A の挿入も対象）
- `claude.recursive` / `codex.recursive` 設定キーを廃止し、ソースごとに
  適切な探索方法を自動選択（旧キーは警告して無視）
- ログ検出・バックアップ・ファイル更新挙動・cclog からの移行について、
  英日ドキュメントを拡充・整合

### 1.1.0
#### 2026/07/22(水)
- ブロック識別を `%PairId%` / `ccxid:` からより明確な `%CcxlogId%` /
  `ccxlogid:` 形式に変更（正式マーカーは `<!-- ccxlogid:<24桁hex> -->`）
- カスタムテンプレートに `<!-- %CcxlogId% -->` の単独行が無い場合は、
  各 Q&A ブロックへ正式マーカーを自動付与
- 日時ベースのブロック識別と旧 `ccxlog-pair:ccxid:` パーサを廃止（旧出力の
  初回書き換えは移行前に保守的にバックアップ）
- 同梱6テンプレートから重複していた `Source=` 行を削除（見出しのソース表示は
  維持）

### 1.0.2
#### 2026/07/22(水)
- 統合・`-cc`・`-cx` の集約ファイル名が `<out>/ccxlog.config.json` で個別に
  設定できることを、キー名と既定値込みで `-h` に表示
- 3つの集約ファイル名を変更する具体例を英日 README に追加

### 1.0.1
#### 2026/07/22(水)
- Claude Code 専用の
  [`@standard-software/cclog`](https://www.npmjs.com/package/@standard-software/cclog)
  と、Claude Code / Codex CLI 両対応の ccxlog の違いを文書化
- `-cc` / `-cx` 専用出力モードを文書化し、
  [GitHub リポジトリ](https://github.com/standard-software/ccxlog)へリンク

### 1.0.0
#### 2026/07/22(水)
- 初回リリース
- **Claude Code**（`~/.claude/projects/`）と **Codex CLI**
  （`~/.codex/sessions/`）のセッションログ（JSONL）を1つの Markdown
  タイムラインに統合
  - 統合の集約出力 `CCXLOG/ccxlog.md`（既定・`both`）
  - `-cc` / `--claude-only` → `cclog.md`、`-cx` / `--codex-only` → `cxlog.md`
    （`--source both|claude|codex` も可）。3つの集約ファイルは共存し、各モードは
    自分のファイルだけを更新
  - `--per-session` でセッションごとのファイル（`cclog_<id>.md` /
    `cxlog_<id>.md`）
- 安定した8キー比較器による両ツール横断の時系列統合（同じログ集合は常に同じ
  決定的順序で描画）
- 各ブロックが `%Source%`（`ClaudeCode` / `Codex`）を持ち、両ツールで進めた
  プロジェクトを1つの履歴として読める
- **セッション横断の重複排除**（集約出力）：resume / fork でコピーされた
  Claude セッションのペアをメッセージ uuid（質問・追いメッセージ・回答）で
  ロスレスに排除。Codex の uuid はファイル内位置ベースのため対象外。
  `--per-session` は意図的に重複排除しない
- **`includeSubdirectories`**（既定 `true`）：`~/work/app` で実行すると
  `~/work/app/frontend` のような入れ子プロジェクトも収集。候補は各セッションの
  実 cwd で確認するため、同接頭辞の兄弟（`~/work/app-backup`）は混入しない。
  `false` で完全一致のみ
- テンプレート（同梱6種）とプレースホルダ駆動の描画
  - `english.md`（既定）/ `japanese.md` と各 `-with-progress` /
    `-with-progress-full` 版
  - プレースホルダ: `%DateTime%` / `%Source%` / `%SourceShort%` / `%PairId%` /
    `%SessionId%` / `%SessionName%` / `%Question%` / `%Answer%` / `%Progress%` /
    `%ProgressFull%` / `%Model%` / `%Version%` / `%GitBranch%` / `%Cwd%` /
    `%Tokens%`
  - シングルパス描画（質問・回答の本文中にあるプレースホルダ文字列は
    再置換しない）
  - 進捗の詳細度はテンプレートに従う（`%Progress%` は要約 / `%ProgressFull%`
    は入出力 JSON＋思考の全文）
- `CCXLOG/ccxlog.config.json` による設定
  - トップレベル（両ソース共通）: `extraCwds` / `includeSubdirectories` /
    `outputAllFileName` / `template`
  - ソース別 `claude` / `codex`: `outputAllFileName` /
    `outputSessionFilePrefix` / `extraLogDirs` / `recursive`、および
    `includeSidechain`（claude）/ `includeDeveloperMessages`（codex）
  - 未知キーや型違いは警告してフォールバック（黙って失敗しない）
- ジャンクション／シンボリックリンク対応（実パスを解決し、両方の
  エンコードのログを統合）
- スマート書き込み（変更なし → no-op／純粋な末尾拡張 → 追記／それ以外 →
  全面書き換え）
- 安全な書き込み：書き込み計画 → 破壊的書き換え前のバックアップ取得**と検証**
  （`backup_CCXLOG_md/`）→ リネームリトライ付きの原子的コミット。バックアップは
  蓄積され、自動削除されない
- `--backup-jsonl` / `--backup-md`：生ソースログ／出力済み Markdown の単独
  バックアップ（実行ごとの `<yyyy-mm-dd_hh-mm-ss>_<hostname>/` フォルダへ）
- `--lock` / `--force-unlock`：出力ディレクトリの排他ロック（オプトイン）
- `--init-template`：同梱テンプレートをプロジェクトへコピーし、ローカル
  コピーを使うよう設定を書き換え
