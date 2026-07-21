# ccxlog

**Language:** [Japanese/日本語](README_Japanese.md)

Merge Claude Code and Codex CLI session logs into one readable Markdown timeline.

`ccxlog` reads the JSONL session logs that **Claude Code** writes under
`~/.claude/projects/<encoded project path>/` and the ones that **Codex CLI**
writes under `~/.codex/sessions/`, then renders every Q&A pair from both — sorted
into a single chronological timeline — as `ccxlog.md` (or one file per session)
in your project. Each block is labelled with its source (`ClaudeCode` / `Codex`),
so a project you drove with both tools reads as one history.

The output is regenerated on every run, but the file is only modified when its
content would actually change — and when the new content is a strict append, only
the tail is appended so editors don't reload from the top.

If you only want one tool, `-cc` behaves like a dedicated Claude-Code exporter
(writing `cclog.md`) and `-cx` like a dedicated Codex exporter (writing
`cxlog.md`) — `ccxlog` unifies both without giving up either.

## ccxlog and cclog

[`@standard-software/cclog`](https://www.npmjs.com/package/@standard-software/cclog)
is dedicated to **Claude Code** logs. In contrast, `ccxlog` supports both
**Claude Code and Codex CLI**, merging them into `ccxlog.md` by default.

You can also use `ccxlog` as a dedicated exporter for either source:

```bash
ccxlog -cc      # Claude Code only -> CCXLOG/cclog.md
ccxlog -cx      # Codex CLI only   -> CCXLOG/cxlog.md
```

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

### Options

```
ccxlog [project-path] [options]

Arguments:
  project-path           Project directory (defaults to the current directory).

Options:
  -cc, --claude-only     Claude Code logs only  -> CCXLOG/cclog.md
  -cx, --codex-only      Codex logs only        -> CCXLOG/cxlog.md
  --source <s>           Explicit form of the above: both|claude|codex (default both).
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
                         and exit WITHOUT regenerating anything. On-demand trigger
                         of the same backup ccxlog makes automatically before a
                         destructive rewrite.
  --lock                 Opt-in exclusive lock on <out> for the run (guards against
                         two ccxlog runs writing the same output concurrently).
  --force-unlock         Remove a stale lock left by a crashed run (use with --lock).
  --dry-run              Don't write files; report what would be written.
  --verbose              Verbose logging.
  -v, -V, --version      Show version and exit.
  -h, --help             Show this help.
```

### Backing up the raw JSONL logs

The source logs both tools write live in folders whose names/locations are
derived from the machine (Claude Code encodes the project's absolute path; Codex
groups sessions by date). Move to a different machine (or a different path) and
`ccxlog` may no longer see the old sessions. To keep a local copy of the raw
logs before that happens:

```bash
ccxlog --backup-jsonl
```

This copies every discovered `.jsonl` into
`CCXLOG/backup_jsonl/<yyyy-mm-dd_hh-mm-ss>_<hostname>/` (a new timestamped folder
per run, with the machine name appended so backups stay attributable per PC).
`--backup-jsonl` is a **standalone action**: it backs up only and exits, so it
does **not** (re)write any Markdown — run `ccxlog` without the flag for that.
Combine with `--dry-run` to preview the destination without copying, or
`--verbose` to see each copied file. The `CCXLOG/` output directory (and thus
`backup_jsonl/`) is typically git-ignored, so backups won't pollute your repo.

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
  "outputAllFileName": "ccxlog.md",
  "template": "templates/english.md",

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

Use backslash-escaped paths on Windows (`C:\\Users\\...`) and forward-slash paths
on Ubuntu/macOS (`/home/you/...`).

### Top-level (both sources)

| Field                     | Description                                                                 |
|---------------------------|-----------------------------------------------------------------------------|
| `extraCwds`               | Additional project directories whose logs (from either tool) should be merged into the output. |
| `includeSubdirectories`   | If `true` (default), also collect logs from projects whose cwd is a *subdirectory* of the project ccxlog runs in (e.g. running in `~/work/app` also gathers `~/work/app/frontend`). Nested candidates are verified against each session's real cwd, so same-prefix siblings like `~/work/app-backup` are never included. Set `false` to match only the exact project path (plus `extraCwds` / `extraLogDirs`). |
| `outputAllFileName`       | Filename for the **merged** (`both`) aggregate output. Default `ccxlog.md`. The title inside the file is derived from the basename. |
| `template`                | Path to a Markdown template. Resolved against ccxlog's own `templates/` dir first, then your CCXLOG dir. |

### Per-source (`claude` / `codex`)

| Field                     | Description                                                                 |
|---------------------------|-----------------------------------------------------------------------------|
| `outputAllFileName`       | Aggregate filename for `-cc` / `-cx` mode. Defaults `cclog.md` / `cxlog.md`. |
| `outputSessionFilePrefix` | Prefix for per-session filenames (used with `--per-session`). Defaults `cclog_` / `cxlog_`, so files are `cclog_<id>.md` / `cxlog_<id>.md`. Empty string means no prefix. |
| `extraLogDirs`            | Additional raw log directories to read verbatim (`~/.claude/projects/...` for claude, `~/.codex/sessions/...` for codex). Entries are read without the cwd filter. |
| `recursive`               | If `true`, descend into subdirectories of each log dir. Default `false` for claude, `true` for codex (Codex nests session files by date). |
| `includeSidechain`        | *(claude only)* If `true`, include subagent / sidechain pairs in the output. |
| `includeDeveloperMessages`| *(codex only)* If `true`, include Codex developer/system messages in the output. |

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
| `%PairId%`        | `ccxid` — an answer-independent, cross-tool-stable id used as the block's identity marker |
| `%SessionId%`     | The session id                                           |
| `%SessionName%`   | Human-readable session name — the custom title if set, else the tool's auto-generated title, else empty |
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

> **⚠️ Keep the first two lines: the `<!-- ccxlog-pair:%PairId% -->` marker and
> the `# %DateTime%` header.**
> The automatic pre-overwrite backup (see Notes below) identifies each Q&A block
> by these markers. If your custom template drops them, no block has an identity
> anymore and the detector goes blind: the backup will never fire again, even
> when pairs genuinely vanish from the output. All six bundled templates keep
> this form — customize anything you like after them.

## Output format

`ccxlog.md` is a flat chronological sequence of Q&A blocks. Each block is
rendered from the template. By default (English template):

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

The `[ClaudeCode]` / `[Codex]` tag and the `Source=` line come from `%Source%`,
so a merged timeline makes clear which tool each turn belongs to. The
`<!-- -->` around the answer keeps the assistant's own Markdown (headings,
lists, code) from colliding with the template's structure, and as a side effect
Markdown viewers collapse it so long replies don't dominate the preview. Remove
it from your template if you'd rather see answers expanded by default.

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
- The output is fully regenerated on every run; if you delete a source log, the
  corresponding pairs disappear from the output on the next run.
- **Pre-overwrite backup of the Markdown.** When a run would rewrite an existing
  output `.md` *destructively* — at least one block present in the old file is
  missing from the new content — the existing file is first copied to
  `CCXLOG/backup_CCXLOG_md/<yyyy-mm-dd_hh-mm-ss>_<hostname>/` so the previous
  version is never lost. Backup folders accumulate and are never pruned. A plain
  append, an unchanged run, a first-time create, or a rewrite that keeps every
  block never produces a backup, so these folders only appear when content
  actually disappeared. Before any destructive write the backup is taken **and
  verified**; if it can't be verified, the overwrite is aborted.

## License

MIT
