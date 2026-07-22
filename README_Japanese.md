# ccxlog

**Language:** [English/英語](README.md)

ccxlog は、Claude Code と Codex CLI のセッションログを、読みやすい1つの Markdown
タイムラインに統合するコマンドラインツールです。

ccxlog の開発を始めた2026年、ソフトウェア開発におけるコード生成 AI、特に
Claude Code と Codex の存在は非常に大きなものになりました。AI が生成したコードは
Git のコミット履歴で管理できますが、「AI に何を依頼し、AI がどう答えたか」という
開発の過程は、あとから簡単に振り返れる形では残りません。

ccxlog は、プロジェクトで交わした Claude Code と Codex とのやり取りを収集し、
`CCXLOG/ccxlog.md` に時系列で記録します。2つのツールを併用していても、指示と回答を
プロジェクトの1つの履歴として読み返せます。

ccxlog が、みなさんの開発記録と生産性の向上に役立つことを願っています。


## ccxlog と cclog の違い

前身である [`@standard-software/cclog`](https://www.npmjs.com/package/@standard-software/cclog) は
**Claude Code 専用**のログ出力ツールです。それに対して `ccxlog` は
**Claude Code と Codex CLI の両方**に対応し、既定では両方のログを
`ccxlog.md` に統合します。

`cclog` の主な機能は `ccxlog` に取り込まれています。`ccxlog` は Claude Code
専用モードでも動作するため、`cclog` から容易に移行できます。

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

### ログの保存場所と検出

Claude Code は、プロジェクトの絶対パスをエンコードしたディレクトリ
`~/.claude/projects/<エンコードされたプロジェクトパス>/` にセッションログを
書き出します。Codex CLI のセッションログは `~/.codex/sessions/` 以下に日付別で
保存されます。

ccxlog はこれらの JSONL ファイルを検出し、実行対象のプロジェクトに属するセッションを
読み取ります。別の場所にあるログを追加で読み取る場合は、設定ファイルの
`claude.extraLogDirs` または `codex.extraLogDirs` を使用できます。

### オプション

```
ccxlog [project-path] [options]

Arguments:
  project-path           プロジェクトディレクトリ（既定はカレントディレクトリ）。

Options:
  -cc                    Claude Code のログのみ  -> CCXLOG/cclog.md
  -cx                    Codex のログのみ        -> CCXLOG/cxlog.md
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
                         コピーして、何も再生成せずに終了する（既存出力を末尾追記
                         以外の方法で書き換える前に
                         ccxlog が自動で取るのと同じバックアップの手動トリガ）。
  --lock                 実行中、<out> に排他ロックを取る（2つの ccxlog 実行が同じ
                         出力を同時に書くのを防ぐ・オプトイン）。
  --force-unlock         クラッシュが残した古いロックを外す（--lock と併用）。
  --dry-run              ファイルを書かず、書き込む予定を報告する。
  --verbose              詳細ログ。
  -v, -V, --version      バージョンを表示して終了。
  -h, --help             ヘルプを表示。
```

### 出力 Markdown の手動／自動バックアップ

ccxlog は、既存の出力 Markdown を末尾追記以外の方法で更新する場合、書き換え前の
ファイルを自動でバックアップします。例えば、テンプレートを変更した場合、過去の時点に
Q&Aが追加された場合、保存期間を過ぎた生 JSONL ログが削除されて以前のQ&Aが出力から
消える場合などが該当します。

初回作成、内容に変化がない場合、既存内容を保った純粋な末尾追記ではバックアップを
作成しません。

自動バックアップは、次のディレクトリに保存されます。

```text
CCXLOG/backup_CCXLOG_md/<yyyy-mm-dd_hh-mm-ss>_<hostname>/
```

バックアップは書き換え前に取得・検証され、正常に保存できなければ元の Markdown を
書き換えません。これにより、生 JSONL ログから過去のやり取りが消えたあとでも、
それまで `ccxlog.md` に出力されていた内容をバックアップから確認できます。

任意のタイミングで手動バックアップを取ることもできます。

```bash
ccxlog --backup-md
```

`--backup-md` はバックアップ専用の単独アクションです。出力済みの ccxlog 管理下の
Markdown をコピーして終了し、ログの再収集や Markdown の再生成は行いません。


### 生 JSONL ログのバックアップ

両ツールが書き出すソースログは、マシンに依存した名前・場所のフォルダにあります
（Claude Code はプロジェクトの絶対パスをエンコードし、Codex は日付でセッションを
まとめる）。別マシン（や別パス）に移ると `ccxlog` が古いセッションを見つけられなく
なることがあります。そうなる前に生ログのローカルコピーを残すには:

```bash
ccxlog --backup-jsonl
```

保存先は次の構成です。

```
  CCXLOG/
  └─ backup_jsonl/
     └─ <yyyy-mm-dd_hh-mm-ss>_<hostname>/
        ├─ cc/   ← Claude Code の JSONL
        └─ cx/   ← Codex の JSONL
```

`--backup-jsonl` は**単独アクション**で、バックアップだけして終了するので、
Markdown の（再）生成は**行いません**。
`--dry-run` と併用すればコピー先のプレビュー、
`--verbose` でコピーした各ファイルを確認できます。

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
    "includeSidechain": false
  },
  "codex": {
    "outputAllFileName": "cxlog.md",
    "outputSessionFilePrefix": "cxlog_",
    "extraLogDirs": [],
    "includeDeveloperMessages": false
  }
}
```

Windows ではバックスラッシュをエスケープしたパス（`C:\\Users\\...`）、
Ubuntu/macOS ではスラッシュ区切りのパス（`/home/you/...`）を使います。


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
| `includeSidechain`        | *(claude のみ)* `true` ならサブエージェント／サイドチェーンのペアも出力に含める。 |
| `includeDeveloperMessages`| *(codex のみ)* `true` なら Codex の developer/system メッセージも出力に含める。 |

ログディレクトリを再帰探索するかどうかは、ソースごとに自動選択され、設定する必要は
ありません。Claude Code はログディレクトリ直下のみ、Codex はセッションが日付別の
サブディレクトリに保存されるため再帰的に探索します。

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
| `%CcxlogId%`      | `ccxlogid` — 回答非依存でツール横断的に安定な ID。ブロックの識別マーカーとして使われる |
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

正式な識別マーカーは、単独行として完全一致する `<!-- %CcxlogId% -->` です。
出力時には `<!-- ccxlogid:<24桁の16進数> -->` になります。この行はカスタム
テンプレート内の任意の位置に置けます。行が存在しない場合は、`%CcxlogId%` が本文中に
表示用として存在していても、ccxlogが各Q&Aブロックの先頭へ正式マーカーを自動挿入
します。`%DateTime%` は人間向けのメタデータであり、ブロック識別には使用しません。

## 出力形式

`ccxlog.md` は Q&A ブロックのフラットな時系列シーケンスです。各ブロックはテンプレートで
描画されます。既定（英語テンプレート）では:

```markdown
<!-- ccxlogid:1f3c... -->
# 2026/05/27 Wed 11:03:49   [ClaudeCode] Session:My first session:ec5e9974-...
Model=claude-opus-4-8 Version=2.1.205
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

`[ClaudeCode]` / `[Codex]` タグは `%Source%` から来るので、統合タイムラインでも
各ターンがどのツールのものか一目で分かります。回答を囲む
`<!-- -->` は、アシスタント自身の Markdown（見出し・リスト・コード）がテンプレートの
構造と衝突しないようにするためで、副次的に Markdown ビューアが折りたたむので長い返答が
プレビューを占有しません。既定で回答を展開したければ、テンプレートから外してください。

### ファイル更新時の動作

ccxlog は、生成結果が変わる場合にだけ出力ファイルを更新します。新しいQ&Aが既存の
タイムラインの末尾に加わるだけの場合は、ファイル全体を書き直さず、新しい内容だけを
末尾へ追記します。

そのため、`ccxlog.md` を Visual Studio Code などのエディタで開いたまま実行しても、
ファイル全体の再読み込みによって表示位置が先頭へ戻ることはなく、読み進めていた位置を
保ったまま最新のログを追加できます。内容に変化がない場合は、ファイルの更新日時も
変更しません。

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
- 出力内容は実行のたびにソースログから再構築されます。ソースログを削除すると、次回実行で
  該当ペアが出力から消えます。実際のファイル更新では、変更なし・末尾追記・全体書き換えを
  判別します。
- **Markdown の上書き前バックアップ。** 既存の出力 `.md` を末尾追記以外の方法で
  更新する場合は、書き換える前に既存ファイルを
  `CCXLOG/backup_CCXLOG_md/<yyyy-mm-dd_hh-mm-ss>_<hostname>/` にコピーするので、
  以前のバージョンが失われることはありません。テンプレート変更、過去の時点へのQ&Aの
  挿入、古い内容の削除も対象です。バックアップフォルダは蓄積され、自動削除されません。
  初回作成・変化なし・純粋な末尾追記ではバックアップを作成しません。書き換え前には
  バックアップを取得して**検証**し、検証できなければ上書きを中止します。

## License

MIT
