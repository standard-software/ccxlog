# ccxlog

**Language:** [Japanese](README_Japanese.md)

ccxlog is a command-line tool that combines Claude Code and Codex CLI session
logs into one readable Markdown timeline.

When development of ccxlog began in 2026, code-generation AI—especially Claude
Code and Codex—had become a major part of software development. Git can preserve
the code produced by AI, but the development process itself—what you asked the
AI to do and how it responded—is not left behind in an easily reviewable form.

ccxlog collects your project's conversations with Claude Code and Codex and
records them chronologically in `CCXLOG/ccxlog.md`. Even when you use both tools,
you can read their instructions and responses as one project history.

We hope ccxlog helps you preserve your development history and improve your
productivity.

## ccxlog and cclog

Its predecessor,
[`@standard-software/cclog`](https://www.npmjs.com/package/@standard-software/cclog),
is dedicated to **Claude Code** logs. In contrast, `ccxlog` supports both
**Claude Code and Codex CLI**, merging them into `ccxlog.md` by default.

The main features of `cclog` have been incorporated into `ccxlog`. Because
`ccxlog` can also run in Claude Code-only mode, migrating from `cclog` is easy.

## Install

```bash
npm install -g @standard-software/ccxlog
```

The package is published on npm as
[`@standard-software/ccxlog`](https://www.npmjs.com/package/@standard-software/ccxlog).
The source repository is
[`standard-software/ccxlog`](https://github.com/standard-software/ccxlog).
The installed CLI command is just `ccxlog`.

## Usage

Run it inside any project directory you've used with Claude Code and/or Codex:

```bash
cd /path/to/your/project
ccxlog
```

This writes `CCXLOG/ccxlog.md` with every Q&A pair from every Claude Code and
Codex session for that project, merged and sorted chronologically.

To export a single source:

```bash
ccxlog -cc      # Claude Code only  -> CCXLOG/cclog.md
ccxlog -cx      # Codex only        -> CCXLOG/cxlog.md
```

The three aggregate files (`ccxlog.md`, `cclog.md`, `cxlog.md`) coexist in the
output directory; each mode only touches its own file.

### Log locations and discovery

Claude Code writes session logs under a directory that encodes the project's
absolute path: `~/.claude/projects/<encoded project path>/`. Codex CLI stores
session logs by date under `~/.codex/sessions/`.

ccxlog discovers these JSONL files and reads the sessions that belong to the
target project. To read logs from another location, use `claude.extraLogDirs` or
`codex.extraLogDirs` in the configuration file.

### Options

```
ccxlog [project-path] [options]

Arguments:
  project-path           Project directory (defaults to the current directory).

Options:
  -cc                    Claude Code logs only  -> CCXLOG/cclog.md
  -cx                    Codex logs only        -> CCXLOG/cxlog.md
  --out <dir>            Output directory (default: <project-path>/CCXLOG).
  --per-session          Write one file per session (cclog_<id>.md / cxlog_<id>.md)
                         instead of the aggregated file.
  --init-template        Copy the bundled template into <out>/templates/ and
                         rewrite ccxlog.config.json to use the local copy
                         (lets you edit it without touching the global install).
  --backup-jsonl         Back up only: copy the discovered source .jsonl logs
                         into <out>/backup_jsonl/<yyyy-mm-dd_hh-mm-ss>_<hostname>/
                         and exit WITHOUT writing any Markdown (preserves the raw
                         logs locally — e.g. before swapping PCs, since the source
                         log location is derived from the machine-specific project
                         path). The folder name embeds the machine name so backups
                         stay attributable per PC.
  --backup-md            Back up only: copy the already-exported Markdown in <out>
                         into <out>/backup_CCXLOG_md/<yyyy-mm-dd_hh-mm-ss>_<host>/
                         and exit WITHOUT regenerating anything. (Automatic
                         pre-overwrite backups are stored separately, in
                         backup_CCXLOG_md_auto/.)
  --lock                 Explicitly request the exclusive output lock (write
                         operations and --watch lock automatically; this option is
                         retained for compatibility).
  --force-unlock         Remove a stale lock left by a crashed run (use with --lock).
  --watch                Run repeatedly: process, wait N seconds, process again
                         (N = watchIntervalSeconds in ccxlog.config.json; default 5).
  --watch=<n><unit>      Same, but stop after the given duration measured from the
                         start (positive integer + one unit s/m/h/d, e.g.
                         --watch=60s). A number without a unit (--watch=60) is an
                         error.
  --dry-run              Don't write files; report what would be written.
  --verbose              Verbose logging.
  -v, -V, --version      Show version and exit.
  -h, --help             Show this help.
```

### Watch mode

`ccxlog --watch` keeps a single ccxlog run going: it processes, waits N seconds,
processes again, and so on, so `CCXLOG/ccxlog.md` stays current while you work.
It combines with `-cc` / `-cx` / `--out` / `--per-session` / `--dry-run` /
`--verbose`; each cycle is exactly the same operation as one plain
run, including the smart-write behavior described below (unchanged content is a
noop, so the file you have open in an editor is not rewritten every 5 seconds).

```bash
ccxlog --watch            # until you stop it
ccxlog --watch=60s        # stop 60 seconds after the start
ccxlog -cc --watch=2h     # Claude Code only, for two hours
```

- The wait is **fixed**, not a fixed period: with a 5 s wait and 3 s of
  processing, cycles start roughly every 8 s. Cycles never overlap or catch up.
- The duration unit is required and single: `s`, `m`, `h` or `d`, from `1s` to
  `366d`. `--watch=60`, `--watch=060s` and `--watch=1h30m` are usage errors.
- A watch holds the output lock from startup until it stops, including between
  cycles. Another watch or one-shot ccxlog writing to the same output directory
  exits with a lock error. One-shot write operations also lock automatically.
- `--watch` cannot be combined with `--force-unlock`: a watch would tear off
  someone else's lock on every cycle. If a crashed run left a stale lock behind,
  clear it with a one-shot `ccxlog --lock --force-unlock` and then start the
  watch.
- The wait length comes from `watchIntervalSeconds` in the configuration file
  (default 5). It is re-read every cycle, so editing it takes effect without a
  restart.
- By default only cycles that changed something print a line. `--verbose` prints
  the full per-cycle detail.
- Exit codes: 0 when the duration elapses, 130 for Ctrl+C, 143 for `kill`
  (POSIX), 1 for a startup failure, 2 for a usage error. A failed cycle does not
  stop the watch and does not change the exit code.

The `=` form is safe to type as-is in PowerShell, bash, zsh and cmd.exe; no
shell quoting is required.

#### Incremental re-parsing

From the second cycle on, a watch only re-reads log files that actually changed.
It keeps the parsed sessions of the previous cycle in memory and compares each
discovered file by four attributes — **size, mtime, device id and inode**. If all
four match, the file is neither re-read nor re-scanned; the Codex "this rollout
belongs to another project" verdict is remembered the same way. Files that
changed are re-read, new files are read, and files that are no longer discovered
are dropped from memory.

- The output is unaffected: a cycle that reuses cached parses writes exactly the
  same bytes as a cold run over the same logs. Merging, de-duplication,
  `ccxlogid` numbering and the smart-write decision all stay identical.
- Only sessions that reached the output keep their parsed data. A file that was
  read and then discarded — not this project's, or not this source's format — is
  remembered by its verdict alone, so a watch holds no more in memory than a
  single run does.
- The cache lives only inside the running watch process. Nothing is written to
  disk, and it is gone when the watch stops. The first cycle is always cold.
- Any change to the configuration, the target project or the mode drops the whole
  cache, so the next cycle re-reads everything. Symlinked paths are resolved
  afresh every cycle, so re-pointing a symlink also takes effect on the next one
  — including a link a session's own `cwd` goes through: a remembered "belongs
  to another project" verdict is re-checked against that resolution each cycle
  and thrown away as soon as it changes.
- `--verbose` reports the split for every cycle, e.g.
  `… , cache 2 reparsed / 238 reused`.

**Reading the `--verbose` counters.** `files` is what discovery found;
`fully read` is how many of those files were analysed for this cycle — *not* how
many were read from disk. Under `--watch`, a file whose parse came from the cache
is still counted in `fully read`. The number actually read from disk this cycle is
`reparsed`; `reused` is the rest. In a quiet cycle you will therefore see a large
`fully read` next to `reparsed: 0`, and that is the mechanism working.

On an unchanging 46 MiB log set (240 files), no-change cycles went from 0.8 s to
0.4 s; the remaining time is discovery, rendering and the smart-write comparison,
which this mechanism does not touch. Peak memory is set by the first (cold)
cycle and does not grow with the number of cycles.

#### Stopping a watch

Press **Ctrl+C** in the terminal that runs it. The watch finishes the cycle it is
in, prints a summary, and exits with code 130.

To stop it from another terminal, use your OS with the pid printed in the start
banner:

```
ccxlog watch started (pid 12345): interval 5s, duration unlimited, mode both
  project: C:\Users\you\projects\my-app
  output:  C:\Users\you\projects\my-app\CCXLOG\ccxlog.md
Press Ctrl+C to stop, or terminate pid 12345 from another terminal (e.g. taskkill /F /PID 12345).
```

- **Windows**: `taskkill /F /PID 12345`
- **Linux / WSL / macOS**: `kill 12345` — this is a graceful stop (SIGTERM): the
  current cycle finishes, the summary is printed, and the exit code is 143.

The output file is committed atomically (write to a temporary file, then
rename), so stopping a watch at any moment — including a force kill — never
leaves a half-written Markdown file behind.

### Manual and automatic output Markdown backups

The automatic backup is a last line of defense against losing conversation
pairs. When ccxlog must rewrite existing output Markdown, it backs up the file
first **only if at least one `ccxlogid` present in the old file would be
missing from the new content** — for example when an older Q&A disappears
because its source JSONL has expired. When the old file cannot be judged
safely (no valid `ccxlogid`, malformed or duplicate ids, or the new content
fails to parse), ccxlog also backs up, erring on the safe side.

No backup is created for a first-time file, unchanged content, a strict
append, or a rewrite that keeps every existing `ccxlogid` (answer updates,
template changes, inserting a Q&A at an earlier point in the timeline,
reordering, and so on).

Automatic backups are stored in their own folder, separate from manual
`--backup-md` copies — anything appearing here is a signal that previously
rendered pairs were about to disappear:

```text
CCXLOG/backup_CCXLOG_md_auto/<yyyy-mm-dd_hh-mm-ss>_<hostname>/
```

The backup is created and verified before the rewrite. If verification fails,
the original Markdown is not modified. This lets you recover content that had
already been exported to `ccxlog.md` even after it disappears from the source
JSONL logs.

You can also create a backup manually at any time:

```bash
ccxlog --backup-md
```

`--backup-md` is a standalone backup action. It copies exported Markdown managed
by ccxlog and exits without rediscovering logs or regenerating Markdown.

### Backing up the raw JSONL logs

The source logs both tools write live in folders whose names/locations are
derived from the machine (Claude Code encodes the project's absolute path; Codex
groups sessions by date). Move to a different machine (or a different path) and
`ccxlog` may no longer see the old sessions. To keep a local copy of the raw
logs before that happens:

```bash
ccxlog --backup-jsonl
```

The destination has this structure:

```text
CCXLOG/
└─ backup_jsonl/
   └─ <yyyy-mm-dd_hh-mm-ss>_<hostname>/
      ├─ cc/   ← Claude Code JSONL, mirroring the live layout:
      │        <session id>.jsonl and <session id>/subagents/agent-*.jsonl
      │        (subagent transcripts are always backed up, regardless of
      │        the includeSubagents setting)
      └─ cx/   ← Codex JSONL, preserving the <yyyy>/<mm>/<dd>/ date tree
```

Because the structure mirrors the live log layout, a snapshot can be read
back exactly like the real log folders:

```json
"claude": { "extraLogDirs": ["backup_jsonl/<stamp>/cc"] },
"codex":  { "extraLogDirs": ["backup_jsonl/<stamp>/cx"] }
```

`--backup-jsonl` is a **standalone action**: it backs up only and exits without
(re)generating Markdown. Combine it with `--dry-run` to preview the destination
or `--verbose` to see each copied file.

Files already under the destination (`<out>/backup_jsonl/`) are never used as
a copy source, so repeated backups do not snowball into backups of backups.
This makes it safe to point `extraLogDirs` at earlier snapshots (e.g.
`backup_jsonl/<stamp>/cc`) to keep rendering sessions whose original logs have
expired — the cross-file de-duplication collapses the overlap with live logs.

## Configuration

Drop a `ccxlog.config.json` in the output directory
(`<project>/CCXLOG/ccxlog.config.json`) to customize behavior. Settings shared by
both sources sit at the top level; source-specific settings live under a `claude`
or `codex` namespace:

```json
{
  "extraCwds": [
    "C:\\Users\\you\\projects\\another-project",
    "/home/you/projects/another-project"
  ],
  "includeSubdirectories": true,
  "watchIntervalSeconds": 5,
  "outputAllFileName": "ccxlog.md",
  "template": "templates/english.md",

  "claude": {
    "outputAllFileName": "cclog.md",
    "outputSessionFilePrefix": "cclog_",
    "extraLogDirs": [],
    "includeSubagents": true
  },
  "codex": {
    "outputAllFileName": "cxlog.md",
    "outputSessionFilePrefix": "cxlog_",
    "extraLogDirs": [],
    "includeDeveloperMessages": false,
    "includeSubagents": true
  }
}
```

Use backslash-escaped paths on Windows (`C:\\Users\\...`) and forward-slash paths
on Ubuntu/macOS (`/home/you/...`).

### Top-level (both sources)

| Field                     | Description                                                                 |
|---------------------------|-----------------------------------------------------------------------------|
| `extraCwds`               | Additional project directories whose logs (from either tool) should be merged into the output. |
| `includeSubdirectories`   | If `true` (default), also collect logs from projects whose cwd is a *subdirectory* of the project ccxlog runs in (e.g. running in `~/work/app` also gathers `~/work/app/frontend`). Nested candidates are verified against each session's real cwd, so same-prefix siblings like `~/work/app-backup` are never included. Set `false` to match only the exact project path (plus `extraCwds` / `extraLogDirs`). |
| `watchIntervalSeconds`    | How long `--watch` waits between cycles, in seconds. Integer, 1-86400, default `5`. An out-of-range or non-integer value warns once and falls back to 5. Ignored when `--watch` is not used. |
| `outputAllFileName`       | Filename for the **merged** (`both`) aggregate output. Default `ccxlog.md`. The title inside the file is derived from the basename. |
| `template`                | Path to a Markdown template. Resolved against ccxlog's own `templates/` dir first, then your CCXLOG dir. |

### Per-source (`claude` / `codex`)

| Field                     | Description                                                                 |
|---------------------------|-----------------------------------------------------------------------------|
| `outputAllFileName`       | Aggregate filename for `-cc` / `-cx` mode. Defaults `cclog.md` / `cxlog.md`. |
| `outputSessionFilePrefix` | Prefix for per-session filenames (used with `--per-session`). Defaults `cclog_` / `cxlog_`, so files are `cclog_<id>.md` / `cxlog_<id>.md`. Empty string means no prefix. |
| `extraLogDirs`            | Additional raw log directories to read verbatim (backup snapshots, log trees copied from another machine, ...). Entries are read without the cwd filter, and may point anywhere — including under `<out>` (e.g. `backup_jsonl/<stamp>/cc`). Each source ingests only files in its own format (claude skips Codex rollouts and vice versa; unrelated `.jsonl` is skipped by both, reported under `--verbose`). |
| `includeSubagents`        | If `true` (**default**), render the conversations of subagents — the child AIs or threads a session delegates work to. Set `false` to keep only the main conversation. Each key controls its own source. See [Subagents](#subagents) below. |
| `includeSidechain`        | *(claude only)* The supported former name of `claude.includeSubagents`; `sidechain` is Claude Code's historical term for the same records. It still works on its own. Setting **both** to *different* values is a fatal config error — ccxlog will not silently pick one. |
| `includeDeveloperMessages`| *(codex only)* If `true`, include Codex developer/system messages in the output. |

Log-directory recursion is selected automatically for each source and is not
configurable: Claude Code roots are scanned at the top level, while Codex roots
are scanned recursively because Codex stores sessions in date subdirectories.

### Subagents

Both tools can delegate work to a subagent, and both record what the subagent
did. `claude.includeSubagents` and `codex.includeSubagents` decide whether those
conversations are **rendered**; they default to `true`, so the output is a
complete record of the session.

What counts as a subagent:

- **Claude Code** — pairs marked `isSidechain` inside a session log, plus the
  separate `<session id>/subagents/*.jsonl` transcripts newer versions write,
  which are rendered as additional sessions. (`sidechain` is the historical name
  for the same thing; it survives only in the compatibility key above.)
- **Codex** — a rollout whose `session_meta` says `thread_source: "subagent"` or
  carries `source.subagent`. An ordinary fork or resume is **not** a subagent and
  is never affected by this setting, even though it also carries
  `forked_from_id`.

Three things the setting does *not* do:

- **It does not stop the raw logs from being preserved.** `--backup-jsonl`
  always copies subagent logs from both sources. Whether to *display* a
  conversation and whether to *keep* its log are separate questions.
- **It does not remove mentions of subagents from the main conversation.** Only
  the child's own conversation is affected.
- **It does not make a run cheaper.** Every log is still discovered and fully
  parsed with `false`. Codex subagent rollouts re-record their parent's
  conversation, and answers, progress and token counts that only the child
  recorded are merged back into the parent *before* anything is hidden — which
  can only be done by reading all of it. So `false` reduces what you read, not
  what ccxlog reads: file count, parse volume, peak memory and `--watch` memory
  are the same as with `true`.

Switching the setting is safe in both directions. Turning subagents **on** only
adds blocks, so existing `ccxlogid`s and their content stay exactly as they were
and no automatic backup is needed. Turning them **off** removes blocks, so the
previous Markdown is backed up to `backup_CCXLOG_md_auto/` before the first
destructive rewrite, and per-session files that belong to a subagent session are
backed up and then removed rather than left behind as stale output. Re-running
with the same setting and the same logs is a complete no-op.

If a project's only logs are subagent transcripts, `false` legitimately leaves
nothing to show: ccxlog writes a 0-pair file and exits 0. That is different from
finding no logs at all, which is still an error that leaves existing output
untouched.

### Templates

Six templates ship out of the box:

- `templates/english.md` (default)
- `templates/japanese.md`
- `templates/english-with-progress.md`
- `templates/japanese-with-progress.md`
- `templates/english-with-progress-full.md`
- `templates/japanese-with-progress-full.md`

A template can use the following placeholders:

| Placeholder       | Replaced with                                            |
|-------------------|----------------------------------------------------------|
| `%DateTime%`      | Question timestamp (`YYYY/MM/DD Day HH:MM:SS`)            |
| `%Source%`        | The tool that produced the pair — `ClaudeCode` or `Codex` |
| `%SourceShort%`   | Short source tag — `cc` or `cx`                          |
| `%CcxlogId%`      | `ccxlogid` — an answer-independent, cross-tool-stable id used as the block's identity marker |
| `%SessionId%`     | The session id                                           |
| `%SessionName%`   | Human-readable session name — for Codex, `thread_name` from `~/.codex/session_index.jsonl`; for Claude Code, the custom or generated title; empty when unavailable |
| `%Question%`      | The user's message                                       |
| `%Answer%`        | The assistant's reply                                    |
| `%Progress%`      | (optional) Tool calls between Q and A, **summarized**     |
| `%ProgressFull%`  | (optional) Same, but full tool input/output JSON + thinking |
| `%Model%`         | Model that produced the answer; synthetic entries are skipped |
| `%Version%`       | Tool version the pair ran under                          |
| `%GitBranch%`     | Git branch at the time of the question                    |
| `%Cwd%`           | Working directory at the time of the question             |
| `%Tokens%`        | Token usage summed over the pair's assistant turns. Out-of-source fields stay blank, so a real `0` is distinguishable from "the tool never reported it". |

Whether — and how verbosely — the progress section is rendered is decided
entirely by the template:

- contains neither → tool calls are omitted;
- contains `%Progress%` → summarized (tool name + key arg, result head only);
- contains `%ProgressFull%` → full input/output JSON and thinking blocks.

Use one of the two progress placeholders, not both. (There is no CLI flag for
this — verbosity follows the template.)

A template that references neither placeholder also costs nothing in memory:
the raw tool input/output between Q and A is dropped as soon as a session is
parsed, instead of being kept around (which matters most for `--watch`, whose
resident set holds the previous cycle's analysis). Editing the template to add
or remove a progress placeholder is picked up on the next cycle — the analysis
cache is dropped and every file is re-read, so the output is always the one the
current template asks for.

#### Customizing a template

To edit a template without touching the globally-installed ccxlog files, run:

```bash
ccxlog --init-template
```

This copies the template currently set in `ccxlog.config.json` (or the English
default if no config exists) into `CCXLOG/templates/` and rewrites the config to
point at the local copy. After that, edit the copied file directly. Re-running
`--init-template` when the destination already exists prints an error and does
not overwrite, but still re-applies the config rewrite.

The formal identity marker is the exact standalone line
`<!-- %CcxlogId% -->`, rendered as `<!-- ccxlogid:<24 hex digits> -->`. You may
place that line anywhere in a custom template. If it is absent — even when
`%CcxlogId%` appears inline elsewhere for display — ccxlog automatically prepends
the formal marker to every Q&A block. `%DateTime%` is human-readable metadata,
not a block identity.

## Output format

`ccxlog.md` is a flat chronological sequence of Q&A blocks. Each block is
rendered from the template. By default (English template):

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

The `[ClaudeCode]` / `[Codex]` tag comes from `%Source%`, so a merged timeline
makes clear which tool each turn belongs to. The
`<!-- -->` around the answer keeps the assistant's own Markdown (headings,
lists, code) from colliding with the template's structure, and as a side effect
Markdown viewers collapse it so long replies don't dominate the preview. Remove
it from your template if you'd rather see answers expanded by default.

### File update behavior

ccxlog modifies an output file only when the generated result has changed. When
new Q&A content belongs strictly at the end of the existing timeline, it appends
only the new content instead of rewriting the entire file.

As a result, running ccxlog while `ccxlog.md` is open in an editor such as Visual
Studio Code does not force a full-file reload that returns the view to the top.
You can keep your reading position while the latest logs are appended. When
nothing has changed, the file's modification time is preserved as well.

## Notes

- **Chronological merge.** Pairs from both tools are sorted by a stable
  8-key comparator (question timestamp first, then source, session, and id
  tiebreakers), so the same set of logs always renders in the same order
  regardless of read order.
- **Cross-session de-duplication.** When a Claude Code session is resumed or
  forked, the earlier history is copied verbatim into the new session file, so
  the same turn would otherwise appear once per file. In the aggregate output a
  pair is dropped when any of its message uuids (question, steering follow-ups,
  or answer) was already emitted — matching by uuid, so it is lossless. Codex
  session ids are per-file positional, so Codex pairs are never merged this way.
  `--per-session` output is intentionally left un-deduplicated so each session
  file stays a complete transcript.
- **Codex subagents.** Every time Codex CLI starts a subagent it writes a new
  rollout and copies the parent session's whole conversation into it, with each
  copied line's timestamp rewritten to the child's start time — so old questions
  used to reappear as new ones. A copied pair is dropped only when the identical
  pair is confirmed present in an older rollout of the same lineage; a pair the
  ancestor never had (a compacted child holds history the parent lost) is kept,
  and an answer only the copy had is merged into the surviving original. The
  instructions a subagent receives are rendered as questions of their own, and a
  subagent is listed under its own thread id and agent nickname. Set
  `codex.includeSubagents: false` to hide the child conversations entirely; the
  matching above still runs first, so nothing the child alone recorded is lost.
- **Cancelled questions are kept.** If a Claude Code turn is interrupted
  before any assistant output and the message is retyped, the cancelled
  question is still emitted as its own pair with an empty Answer — including
  chains of consecutive cancellations. Follow-up messages typed while a turn
  has produced no answer yet keep being merged into the same pair as before.
  (Since 1.4.0; previously the retyped message silently replaced the
  cancelled question.)
- Output content is rebuilt from the source logs on every run. If you delete a
  source log, the corresponding pairs disappear on the next run. The actual
  file update is classified as a no-op, strict append, or full rewrite.
- **Pre-overwrite backup of the Markdown.** Whenever a run must rewrite an
  existing output `.md` in a way that would drop at least one `ccxlogid` the
  file already contains (or the comparison cannot be made safely), the existing
  file is first copied to
  `CCXLOG/backup_CCXLOG_md_auto/<yyyy-mm-dd_hh-mm-ss>_<hostname>/` so the previous
  version is never lost. Backup folders accumulate and are never pruned. A
  first-time create, an unchanged run, a strict append, or a rewrite that keeps
  every existing `ccxlogid` (template changes, insertion of an earlier Q&A
  block, answer updates) produces no backup. When a backup is required it is
  taken **and verified** before the rewrite; if it cannot be verified, the
  rewrite is aborted.

## License

MIT
