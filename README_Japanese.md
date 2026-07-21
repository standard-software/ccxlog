# ccxlog

**Language:** [English/英語](README.md)

Claude Code と Codex CLI のセッションログを、1つの読みやすい Markdown タイムラインに統合します。

`ccxlog` は、**Claude Code** が `~/.claude/projects/<エンコードされたプロジェクトパス>/`
に書き出す JSONL セッションログと、**Codex CLI** が `~/.codex/sessions/` に書き出す
ログの両方を読み取り、両者のすべての Q&A ペアを時系列に統合して、プロジェクト内に
`ccxlog.md`（またはセッションごとに1ファイル）として出力します。各ブロックには
出力元（`ClaudeCode` / `Codex`）が付くので、両ツールで進めたプロジェクトも1つの
履歴として読めます。

出力は実行のたびに再生成されますが、内容が実際に変わるときだけファイルを更新します。
新しい内容が末尾への純粋な追記であれば末尾だけを追記するので、エディタが先頭から
再読み込みすることもありません。

片方のツールだけが欲しい場合、`-cc` は Claude Code 専用エクスポータ（`cclog.md` を
出力）、`-cx` は Codex 専用エクスポータ（`cxlog.md` を出力）のように振る舞います。
`ccxlog` はどちらも犠牲にせず両方を統合します。

## ccxlog と cclog の違い

[`@standard-software/cclog`](https://www.npmjs.com/package/@standard-software/cclog)
は **Claude Code 専用**のログ出力ツールです。それに対して `ccxlog` は
**Claude Code と Codex CLI の両方**に対応し、既定では両方のログを
`ccxlog.md` に統合します。

また、オプションを指定すれば、それぞれの専用ログとして出力できます。

```bash
ccxlog -cc      # Claude Code のみ -> CCXLOG/cclog.md
ccxlog -cx      # Codex CLI のみ   -> CCXLOG/cxlog.md
```

## インストール

```bash
npm install -g @standard-software/ccxlog
```

npm 上では
[`@standard-software/ccxlog`](https://www.npmjs.com/package/@standard-software/ccxlog)
として公開されています。ソースコードは
[`standard-software/ccxlog`](https://github.com/standard-software/ccxlog)
で公開しています。インストールされる CLI コマンドは単に `ccxlog` です。

## 使い方

Claude Code や Codex で使ったことのある任意のプロジェクトディレクトリで実行します:

```bash
cd /path/to/your/project
ccxlog
```

これで `CCXLOG/ccxlog.md` に、そのプロジェクトの全 Claude Code・全 Codex セッションの
Q&A ペアが、統合・時系列ソートされて書き出されます。

片方のソースだけを出力するには:

```bash
ccxlog -cc      # Claude Code のみ  -> CCXLOG/cclog.md
ccxlog -cx      # Codex のみ        -> CCXLOG/cxlog.md
```

3つの集約ファイル（`ccxlog.md` / `cclog.md` / `cxlog.md`）は出力ディレクトリに共存し、
各モードは自分のファイルだけを更新します。

### オプション

```
ccxlog [project-path] [options]

Arguments:
  project-path           プロジェクトディレクトリ（既定はカレントディレクトリ）。

Options:
  -cc, --claude-only     Claude Code のログのみ  -> CCXLOG/cclog.md
  -cx, --codex-only      Codex のログのみ        -> CCXLOG/cxlog.md
  --source <s>           上記の明示形: both|claude|codex（既定 both）。
  --out <dir>            出力ディレクトリ（既定: <project-path>/CCXLOG）。
  --per-session          セッションごとに1ファイル出力（cclog_<id>.md / cxlog_<id>.md）。
  --init-template        同梱テンプレートを <out>/templates/ にコピーし、
                         ローカルコピーを使うよう ccxlog.config.json を書き換える
                         （グローバルインストールに触れず編集できる）。
  --backup-jsonl         バックアップのみ: 検出したソース .jsonl ログを
                         <out>/backup_jsonl/<yyyy-mm-dd_hh-mm-ss>_<hostname>/ に
                         コピーして、Markdown を書かずに終了する（生ログをローカルに
                         保全。ソースログの場所はマシン固有のパスから導かれるため、
                         PC 移行前などに）。フォルダ名にマシン名が入るので、
                         どの PC のバックアップか判別できる。
  --backup-md            バックアップのみ: <out> の出力済み Markdown を
                         <out>/backup_CCXLOG_md/<yyyy-mm-dd_hh-mm-ss>_<host>/ に
                         コピーして、何も再生成せずに終了する（破壊的書き換えの前に
                         ccxlog が自動で取るのと同じバックアップの手動トリガ）。
  --lock                 実行中、<out> に排他ロックを取る（2つの ccxlog 実行が同じ
                         出力を同時に書くのを防ぐ・オプトイン）。
  --force-unlock         クラッシュが残した古いロックを外す（--lock と併用）。
  --dry-run              ファイルを書かず、書き込む予定を報告する。
  --verbose              詳細ログ。
  -v, -V, --version      バージョンを表示して終了。
  -h, --help             ヘルプを表示。
```

### 生 JSONL ログのバックアップ

両ツールが書き出すソースログは、マシンに依存した名前・場所のフォルダにあります
（Claude Code はプロジェクトの絶対パスをエンコードし、Codex は日付でセッションを
まとめる）。別マシン（や別パス）に移ると `ccxlog` が古いセッションを見つけられなく
なることがあります。そうなる前に生ログのローカルコピーを残すには:

```bash
ccxlog --backup-jsonl
```

検出したすべての `.jsonl` を
`CCXLOG/backup_jsonl/<yyyy-mm-dd_hh-mm-ss>_<hostname>/`（実行ごとに新しいタイムスタンプ
フォルダ、末尾にマシン名付き）へコピーします。`--backup-jsonl` は**単独アクション**で、
バックアップだけして終了するので、Markdown の（再）生成は**行いません** — それには
フラグなしで `ccxlog` を実行してください。`--dry-run` と併用すればコピー先の
プレビュー、`--verbose` でコピーした各ファイルを確認できます。`CCXLOG/` 出力
ディレクトリ（したがって `backup_jsonl/`）は通常 git 管理外なので、バックアップが
リポジトリを汚すことはありません。

## 設定

出力ディレクトリに `ccxlog.config.json`
（`<project>/CCXLOG/ccxlog.config.json`）を置くと挙動をカスタマイズできます。
両ソース共通の設定はトップレベルに、ソース固有の設定は `claude` / `codex`
名前空間に置きます:

```json
{
  "extraCwds": [
    "C:\\Users\\you\\projects\\another-project",
    "/home/you/projects/another-project"
  ],
  "includeSubdirectories": true,
  "outputAllFileName": "ccxlog.md",
  "template": "templates/japanese.md",

  "claude": {
    "outputAllFileName": "cclog.md",
    "outputSessionFilePrefix": "cclog_",
    "extraLogDirs": [],
    "recursive": false,
    "includeSidechain": false
  },
  "codex": {
    "outputAllFileName": "cxlog.md",
    "outputSessionFilePrefix": "cxlog_",
    "extraLogDirs": [],
    "recursive": true,
    "includeDeveloperMessages": false
  }
}
```

Windows ではバックスラッシュをエスケープしたパス（`C:\\Users\\...`）、
Ubuntu/macOS ではスラッシュ区切りのパス（`/home/you/...`）を使います。

例えば、3種類の集約出力ファイル名をそれぞれ独立して変更できます:

```json
{
  "outputAllFileName": "ALL_AI_LOG.md",
  "claude": {
    "outputAllFileName": "CLAUDE_LOG.md"
  },
  "codex": {
    "outputAllFileName": "CODEX_LOG.md"
  }
}
```

この設定では、`ccxlog` は `ALL_AI_LOG.md`、`ccxlog -cc` は
`CLAUDE_LOG.md`、`ccxlog -cx` は `CODEX_LOG.md` を出力します。
モード間で誤って上書きしないよう、3つには異なる名前を指定してください。

### トップレベル（両ソース共通）

| フィールド                | 説明                                                                        |
|---------------------------|-----------------------------------------------------------------------------|
| `extraCwds`               | 出力に統合したい追加のプロジェクトディレクトリ（どちらのツールのログも対象）。 |
| `includeSubdirectories`   | `true`（既定）なら、ccxlog を実行したプロジェクトの *サブディレクトリ* を cwd とするプロジェクトのログも収集する（例: `~/work/app` で実行すると `~/work/app/frontend` も収集）。候補は各セッションの実 cwd と照合されるので、同接頭辞の兄弟（`~/work/app-backup`）は決して混入しない。`false` にすると、正確なプロジェクトパス（＋ `extraCwds` / `extraLogDirs`）だけに一致。 |
| `outputAllFileName`       | **統合**（`both`）集約出力のファイル名。既定 `ccxlog.md`。ファイル内のタイトルはベース名から導かれる。 |
| `template`                | Markdown テンプレートのパス。まず ccxlog 自身の `templates/` ディレクトリ、次に CCXLOG ディレクトリの順に解決。 |

### ソース別（`claude` / `codex`）

| フィールド                | 説明                                                                        |
|---------------------------|-----------------------------------------------------------------------------|
| `outputAllFileName`       | `-cc` / `-cx` モードの集約ファイル名。既定 `cclog.md` / `cxlog.md`。 |
| `outputSessionFilePrefix` | セッションごとのファイル名の接頭辞（`--per-session` で使用）。既定 `cclog_` / `cxlog_` で、`cclog_<id>.md` / `cxlog_<id>.md` になる。空文字なら接頭辞なし。 |
| `extraLogDirs`            | そのまま読み取る追加の生ログディレクトリ（claude は `~/.claude/projects/...`、codex は `~/.codex/sessions/...`）。cwd フィルタなしで読む。 |
| `recursive`               | `true` なら各ログディレクトリのサブディレクトリへ降りる。既定は claude が `false`、codex が `true`（Codex はセッションファイルを日付でネストするため）。 |
| `includeSidechain`        | *(claude のみ)* `true` ならサブエージェント／サイドチェーンのペアも出力に含める。 |
| `includeDeveloperMessages`| *(codex のみ)* `true` なら Codex の developer/system メッセージも出力に含める。 |

### テンプレート

6つのテンプレートを同梱しています:

- `templates/english.md`（既定）
- `templates/japanese.md`
- `templates/english-with-progress.md`
- `templates/japanese-with-progress.md`
- `templates/english-with-progress-full.md`
- `templates/japanese-with-progress-full.md`

テンプレートでは以下のプレースホルダが使えます:

| プレースホルダ    | 置き換わる内容                                            |
|-------------------|----------------------------------------------------------|
| `%DateTime%`      | 質問のタイムスタンプ（`YYYY/MM/DD Day HH:MM:SS`）          |
| `%Source%`        | ペアの出力元ツール — `ClaudeCode` または `Codex`          |
| `%SourceShort%`   | 短い出力元タグ — `cc` または `cx`                         |
| `%PairId%`        | `ccxid` — 回答非依存でツール横断的に安定な ID。ブロックの識別マーカーとして使われる |
| `%SessionId%`     | セッション ID                                            |
| `%SessionName%`   | 人間可読なセッション名 — 設定していればカスタムタイトル、なければツールの自動生成タイトル、それもなければ空 |
| `%Question%`      | ユーザーのメッセージ                                     |
| `%Answer%`        | アシスタントの返答                                       |
| `%Progress%`      | （任意）Q と A の間のツール呼び出しを**要約**したもの      |
| `%ProgressFull%`  | （任意）同上だが、ツールの入出力 JSON と thinking をフルで |
| `%Model%`         | 回答を生成したモデル（合成エントリは除外）                |
| `%Version%`       | ペアが動作したツールのバージョン                          |
| `%GitBranch%`     | 質問時の Git ブランチ                                     |
| `%Cwd%`           | 質問時の作業ディレクトリ                                  |
| `%Tokens%`        | ペアのアシスタントターンで合算したトークン使用量。ソースにない項目は空欄なので、本当の `0` と「ツールが報告しなかった」を区別できる。 |

進捗セクションを描画するか、どこまで詳しく描画するかは、完全にテンプレートで決まります:

- どちらも含まない → ツール呼び出しは省略
- `%Progress%` を含む → 要約（ツール名＋主要な引数、結果の先頭のみ）
- `%ProgressFull%` を含む → 入出力 JSON と thinking ブロックをフルで

2つの進捗プレースホルダは、両方ではなくどちらか一方を使ってください。（CLI フラグは
なく、詳細度はテンプレートに従います。）

#### テンプレートのカスタマイズ

グローバルにインストールされた ccxlog のファイルに触れずにテンプレートを編集するには:

```bash
ccxlog --init-template
```

これは `ccxlog.config.json` で現在設定されているテンプレート（設定がなければ英語の
既定）を `CCXLOG/templates/` にコピーし、ローカルコピーを指すよう設定を書き換えます。
以降はコピーされたファイルを直接編集してください。コピー先が既に存在する状態で
`--init-template` を再実行すると、エラーを表示して上書きはしませんが、設定の書き換えは
再適用します。

> **⚠️ 最初の2行 — `<!-- ccxlog-pair:%PairId% -->` マーカーと `# %DateTime%`
> ヘッダ — は残してください。**
> 自動の上書き前バックアップ（下記 Notes 参照）は、各 Q&A ブロックをこれらの
> マーカーで識別します。カスタムテンプレートがこれらを落とすと、どのブロックにも
> 識別子がなくなり、検出器が盲目になります: ペアが本当に出力から消えても、二度と
> バックアップが発火しなくなります。同梱の6テンプレートはこの形を保っています —
> それらの後ろは好きにカスタマイズできます。

## 出力形式

`ccxlog.md` は Q&A ブロックのフラットな時系列シーケンスです。各ブロックはテンプレートで
描画されます。既定（英語テンプレート）では:

```markdown
<!-- ccxlog-pair:ccxid:1f3c... -->
# 2026/05/27 Wed 11:03:49   [ClaudeCode] Session:My first session:ec5e9974-...
Source=ClaudeCode Model=claude-opus-4-8 Version=2.1.205
Branch=main Cwd=C:\Users\satoshi\projects\my-app
Tokens=in 6, out 33, cache read 21,758, cache write 8,730
## Question
Hello, can you help me with X?

<!--
## Answer
Sure, here's how...
-->

----------------------------------------
```

`[ClaudeCode]` / `[Codex]` タグと `Source=` 行は `%Source%` から来るので、統合
タイムラインでも各ターンがどのツールのものか一目で分かります。回答を囲む
`<!-- -->` は、アシスタント自身の Markdown（見出し・リスト・コード）がテンプレートの
構造と衝突しないようにするためで、副次的に Markdown ビューアが折りたたむので長い返答が
プレビューを占有しません。既定で回答を展開したければ、テンプレートから外してください。

## Notes

- **時系列統合。** 両ツールのペアは、安定した8キー比較器（まず質問タイムスタンプ、
  次にソース・セッション・ID のタイブレーク）でソートされるので、同じログ集合は
  読み取り順に関係なく常に同じ順序で描画されます。
- **セッション横断の重複排除。** Claude Code のセッションを再開（resume）または
  分岐（fork）すると、以前の履歴が新しいセッションファイルにそのままコピーされるため、
  同じターンがファイルごとに1回ずつ現れてしまいます。集約出力では、ペアのいずれかの
  メッセージ uuid（質問・ステアリングの追いメッセージ・回答）が既に出力済みなら、
  そのペアを落とします — uuid 一致による判定なのでロスレスです。Codex のセッション
  ID はファイル内の位置ベースなので、Codex のペアはこの方法では統合しません。
  `--per-session` 出力は意図的に重複排除しないので、各セッションファイルは完全な
  トランスクリプトのまま残ります。
- 出力は実行のたびに完全再生成されます。ソースログを削除すると、次回実行で該当ペアが
  出力から消えます。
- **Markdown の上書き前バックアップ。** 実行が既存の出力 `.md` を*破壊的に*書き換える
  とき — 旧ファイルにあったブロックの少なくとも1つが新しい内容から欠ける場合 —
  既存ファイルをまず
  `CCXLOG/backup_CCXLOG_md/<yyyy-mm-dd_hh-mm-ss>_<hostname>/` にコピーするので、
  以前のバージョンが失われることはありません。バックアップフォルダは蓄積され、削除
  （prune）されません。純粋な追記・変化なしの実行・初回作成・全ブロックを保つ
  書き換えでは、バックアップは発生しないので、これらのフォルダは内容が実際に消えた
  ときだけ現れます。破壊的書き込みの前にはバックアップを取得**して検証**し、検証
  できなければ上書きを中止します。

## License

MIT
