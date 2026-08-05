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
                         コピーして、何も再生成せずに終了する（自動バックアップは
                         別フォルダ backup_CCXLOG_md_auto/ に保存される）。
  --lock                 出力先の排他ロックを明示する（書き込み系と --watch は
                         自動でロックするため、互換性のために残している）。
  --force-unlock         クラッシュが残した古いロックを外す（--lock と併用）。
  --watch                「処理 → N 秒待機 → 処理」を繰り返す常駐モード
                         （N = ccxlog.config.json の watchIntervalSeconds・既定 5）。
  --watch=<n><単位>      同上。ただし開始からの経過時間で自動停止する
                         （正の整数 + 単位 s/m/h/d を1つ。例 --watch=60s）。
                         単位なし（--watch=60）はエラー。
  --dry-run              ファイルを書かず、書き込む予定を報告する。
  --verbose              詳細ログ。
  -v, -V, --version      バージョンを表示して終了。
  -h, --help             ヘルプを表示。
```

### watch モード（常駐実行）

`ccxlog --watch` は ccxlog の1回実行を「処理 → N 秒待機 → 処理」の繰り返しとして
常駐させ、作業中も `CCXLOG/ccxlog.md` を最新に保ちます。`-cc` / `-cx` / `--out` /
`--per-session` / `--dry-run` / `--verbose` と併用できます。1周期は
通常の1回実行とまったく同じ処理で、後述のスマート書き込みもそのまま働きます
（内容が変わらなければ noop なので、エディタで開いたままのファイルが5秒ごとに
書き換わることはありません）。

```bash
ccxlog --watch            # 停止するまで動き続ける
ccxlog --watch=60s        # 開始から 60 秒で自動停止
ccxlog -cc --watch=2h     # Claude Code のみ・2時間
```

- 待機は**固定**であり、固定周期ではありません。待機5秒・処理3秒なら周期の開始
  間隔は約8秒になります。多重実行・追いつき実行はしません。
- 単位は必須かつ1つだけです（`s` / `m` / `h` / `d`、範囲は `1s`〜`366d`）。
  `--watch=60` `--watch=060s` `--watch=1h30m` はいずれも使用法エラーです。
- watch は周期間の待機中も含め、起動から停止まで出力先をロックします。同じ出力先
  に対する別の watch や通常の ccxlog はロックエラーで終了します。通常の書き込み
  実行も自動でロックします。
- `--watch` と `--force-unlock` は併用できません。watch が周期のたびに他者の
  ロックを剥がし続けることになるためです。クラッシュが古いロックを残した場合は、
  先に `ccxlog --lock --force-unlock` を単発で実行してから watch を起動して
  ください。
- 待機秒数は設定ファイルの `watchIntervalSeconds`（既定5）です。毎周期読み直す
  ため、稼働中に書き換えれば再起動なしで反映されます。
- 既定では「変化があった周期」だけ1行出力します。`--verbose` で周期ごとの詳細が
  出ます。
- 終了コード: 動作時間の満了は 0、Ctrl+C は 130、`kill`（POSIX）は 143、起動時の
  致命エラーは 1、使用法エラーは 2。周期の失敗で watch は止まらず、終了コードにも
  影響しません。

`=` 形式は PowerShell / bash / zsh / cmd.exe のいずれでも、そのまま入力でき、
引用符は不要です。

#### 差分再解析（変化のないファイルを読み直さない）

2周期目以降、watch は**変化したログファイルだけを読み直します**。前周期の解析
結果をメモリに保持し、発見した各ファイルを **size / mtime / デバイスID / inode**
の4属性で照合します。4つすべてが一致すれば再読込も再走査もしません。Codex の
「この rollout は他プロジェクト所属」というプリフィルタ判定も同じく再利用します。
変化したファイルは読み直し、新規ファイルは当然読み、発見されなくなったファイルは
メモリから捨てます。

- 出力は変わりません。キャッシュを再利用した周期は、同じログに対するコールド実行
  と**バイト単位で同一**の内容を書きます（マージ・重複排除・`ccxlogid` の採番・
  スマート書き込みの判定はすべて同一です）。
- 保持するのは**出力に寄与したセッションの解析結果だけ**です。読んだうえで捨てた
  ファイル（対象プロジェクトに属さない・そのソースの形式でない）は判定結果だけを
  覚えるので、watch が抱えるメモリは1回実行と変わりません。
- キャッシュは稼働中の watch プロセスの中だけに存在します。ディスクには一切書かず、
  watch を止めれば消えます。1周期目は常にコールドです。
- 設定・対象プロジェクト・モードのいずれかが変わると、キャッシュは全部破棄され、
  次の周期は全ファイルを読み直します。symlink の解決も毎周期やり直すため、
  symlink を張り替えた場合も次の周期から反映されます。これはセッション自身の
  `cwd` が経由するリンクにも当てはまります。「他プロジェクト所属」として覚えた
  判定は、その解決結果と毎周期照合し、変わっていれば直ちに捨てて再走査します。
- `--verbose` では周期ごとに内訳が出ます
  （例: `… , cache 2 reparsed / 238 reused`）。

**`--verbose` の件数の読み方**: `files` は探索で見つけたファイル数、`fully read` は
そのうち**その周期の解析対象になった**ファイル数で、**その周期にディスクから読んだ
数ではありません**。`--watch` では、解析結果をキャッシュから得たファイルも
`fully read` に数えます。その周期に実際に読んだのは `reparsed` の分だけで、残りが
`reused` です。変化のない周期で `fully read` が大きいまま `reparsed: 0` になるのが
正常な状態です。

変化のない 46 MiB のログ（240 ファイル）では、無変化周期の処理時間が 0.8 秒から
0.4 秒になりました。残りは探索・整形・スマート書き込みの比較で、この仕組みの
対象外です。ピークメモリは1周期目（コールド）で決まり、周期を重ねても増えません。

#### watch の停止

起動したターミナルで **Ctrl+C** を押してください。実行中の周期を完走し、終了
サマリを表示してから終了コード 130 で終わります。

別のターミナルから止めたい場合は、開始バナーに表示される pid を指定して OS の
手段で終了してください。

```
ccxlog watch started (pid 12345): interval 5s, duration unlimited, mode both
  project: C:\Users\you\projects\my-app
  output:  C:\Users\you\projects\my-app\CCXLOG\ccxlog.md
Press Ctrl+C to stop, or terminate pid 12345 from another terminal (e.g. taskkill /F /PID 12345).
```

- **Windows**: `taskkill /F /PID 12345`
- **Linux / WSL / macOS**: `kill 12345` — こちらは正規の停止経路（SIGTERM）です。
  実行中の周期を完走し、終了サマリを出して終了コード 143 で終わります。

出力ファイルは一時ファイル + rename の原子的コミットで書かれるため、どの瞬間に
止めても（強制終了であっても）書きかけの Markdown が残ることはありません。

### 出力 Markdown の手動／自動バックアップ

自動バックアップは「会話ペア消失事故を防ぐ最後の砦」です。ccxlog は、既存の出力
Markdown を書き換える際、**書き換え前に存在した `ccxlogid` が書き換え後の内容から
1つでも失われる場合**にのみ、書き換え前のファイルを自動でバックアップします。
例えば、保存期間を過ぎた生 JSONL ログが削除されて以前のQ&Aが出力から消える場合が
該当します。安全に判定できない場合（旧ファイルに有効な `ccxlogid` が無い、
不正形式や重複した ID がある、新内容の解析に失敗した等）も安全側でバックアップ
します。

初回作成、内容に変化がない場合、純粋な末尾追記、および既存の `ccxlogid` がすべて
保たれる書き換え（回答内容の差し替え、テンプレート変更、過去の時点へのQ&Aの挿入、
並び順変更など）ではバックアップを作成しません。

自動バックアップは、手動 `--backup-md` とは**別の専用フォルダ**に保存されます。
ここに何かが増えたら「描画済みのペアが消えようとした」シグナルです。

```text
CCXLOG/backup_CCXLOG_md_auto/<yyyy-mm-dd_hh-mm-ss>_<hostname>/
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
        ├─ cc/   ← Claude Code の JSONL（ライブ配置のミラー:
        │        <セッションID>.jsonl と <セッションID>/subagents/agent-*.jsonl。
        │        subagents は includeSidechain の設定に関わらず必ずバックアップ）
        └─ cx/   ← Codex の JSONL（<年>/<月>/<日>/ の日付ツリーを保存）
```

構造がライブのログ配置のミラーなので、スナップショットは本物のログフォルダと
まったく同じように読み戻せます:

```json
"claude": { "extraLogDirs": ["backup_jsonl/<日時>/cc"] },
"codex":  { "extraLogDirs": ["backup_jsonl/<日時>/cx"] }
```

`--backup-jsonl` は**単独アクション**で、バックアップだけして終了するので、
Markdown の（再）生成は**行いません**。
`--dry-run` と併用すればコピー先のプレビュー、
`--verbose` でコピーした各ファイルを確認できます。

コピー先（`<out>/backup_jsonl/`）配下に既にあるファイルはコピー元として
使われないため、バックアップを繰り返しても「バックアップのバックアップ」で
膨れることはありません。そのため過去のスナップショット
（例: `backup_jsonl/<日時>/cc`）を安心して `extraLogDirs` に指定でき、
元ログが期限切れで消えたセッションも出力し続けられます（現行ログと重なる
ぶんはファイル横断の重複排除で1本化されます）。

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
  "watchIntervalSeconds": 5,
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
| `watchIntervalSeconds`    | `--watch` の待機秒数。1〜86400 の整数、既定 `5`。範囲外・非整数は警告1行を出して 5 にフォールバックする。`--watch` を使わない実行では使われない。 |
| `outputAllFileName`       | **統合**（`both`）集約出力のファイル名。既定 `ccxlog.md`。ファイル内のタイトルはベース名から導かれる。 |
| `template`                | Markdown テンプレートのパス。まず ccxlog 自身の `templates/` ディレクトリ、次に CCXLOG ディレクトリの順に解決。 |

### ソース別（`claude` / `codex`）

| フィールド                | 説明                                                                        |
|---------------------------|-----------------------------------------------------------------------------|
| `outputAllFileName`       | `-cc` / `-cx` モードの集約ファイル名。既定 `cclog.md` / `cxlog.md`。 |
| `outputSessionFilePrefix` | セッションごとのファイル名の接頭辞（`--per-session` で使用）。既定 `cclog_` / `cxlog_` で、`cclog_<id>.md` / `cxlog_<id>.md` になる。空文字なら接頭辞なし。 |
| `extraLogDirs`            | そのまま読み取る追加の生ログディレクトリ（バックアップのスナップショット、別マシンから持ってきたログツリーなど）。cwd フィルタなしで読み、`<out>` 配下（例: `backup_jsonl/<日時>/cc`）を含めどこでも指定できる。各ソースは自分の形式のファイルだけを取り込む（claude は Codex rollout を、codex は Claude セッションログを読み飛ばし、無関係な `.jsonl` は両方が読み飛ばす。`--verbose` で表示）。 |
| `includeSidechain`        | *(claude のみ)* `true` ならサブエージェント／サイドチェーンの記録を出力に含める。セッションログ内の sidechain ペアに加えて、新しめの Claude Code が書く `<セッションID>/subagents/*.jsonl` 形式の別ファイルも探索し、追加セッションとして描画する。 |
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
| `%SessionName%`   | 人間可読なセッション名 — Codex は `~/.codex/session_index.jsonl` の `thread_name`、Claude Code はカスタム名または自動生成名。取得できなければ空 |
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

どちらも参照しないテンプレートでは、メモリ上のコストもかかりません。Q と A の間の
生のツール入出力は、セッションを解析した直後に捨てられ、保持されません（前周期の
解析結果を常駐させ続ける `--watch` で特に効きます）。テンプレートを編集して進捗
プレースホルダを足した／外した場合は次の周期で反映されます。解析キャッシュを捨てて
全ファイルを読み直すので、出力は常に「今のテンプレートが求めるもの」になります。

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
- **Codex のサブエージェント。** Codex CLI はサブエージェントを起動するたびに新しい
  rollout を作り、親セッションの会話全体をそこへ再収録します。その際、再収録された
  各行のタイムスタンプが子の起動時刻に書き換わるため、以前は過去の質問が新しい質問
  として再掲されていました。再収録されたペアを落とすのは、同じ系譜の古い rollout に
  同一のペアが存在すると確認できた場合だけです。親に無い履歴（compaction 後の子が
  持つ履歴）は残し、コピー側にしかない回答は残る側のペアへ統合します。
  サブエージェントが受け取った指示は独立した質問として描画し、サブエージェント自身は
  自分のスレッド ID とエージェント名で一覧されます。
- **キャンセルした質問も残ります。** Claude Code のターンを回答が始まる前に中断して
  打ち直した場合でも、キャンセルされた質問は回答が空の独立したペアとして出力されます
  （連続キャンセルもすべて残ります）。回答がまだ無いターンへの追いメッセージが同じ
  ペアに統合される動作は従来どおりです。（1.4.0 から。以前は打ち直した質問で
  置き換えられ、キャンセルした質問は出力から消えていました。）
- 出力内容は実行のたびにソースログから再構築されます。ソースログを削除すると、次回実行で
  該当ペアが出力から消えます。実際のファイル更新では、変更なし・末尾追記・全体書き換えを
  判別します。
- **Markdown の上書き前バックアップ。** 既存の出力 `.md` の書き換えで、ファイルに
  あった `ccxlogid` が1つでも失われる場合（または安全に判定できない場合）は、
  書き換える前に既存ファイルを
  `CCXLOG/backup_CCXLOG_md_auto/<yyyy-mm-dd_hh-mm-ss>_<hostname>/` にコピーするので、
  以前のバージョンが失われることはありません。バックアップフォルダは蓄積され、
  自動削除されません。初回作成・変化なし・純粋な末尾追記・既存 `ccxlogid` が
  すべて保たれる書き換え（テンプレート変更、過去の時点へのQ&Aの挿入、回答の
  差し替えなど）ではバックアップを作成しません。バックアップが必要な場合は
  書き換え前に取得して**検証**し、検証できなければ上書きを中止します。

## License

MIT
