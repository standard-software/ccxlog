# ccxlog

**Language:** [Japanese](VERSION_Japanese.md)

## Version

### 1.11.0
#### 2026/10/06(Tue)
- recover Codex questions that current Codex CLIs record only as
  `response_item` user messages. A message typed while the model was already
  working was dropped from the output entirely; it now appears as its own
  block
- stop treating the project instructions Codex re-sends when `AGENTS.md`
  changes (`# AGENTS.md instructions ...`) as a question. They used to be
  prepended to the real question, and with `codex.includeDeveloperMessages`
  enabled they replaced it, leaving a block whose question and answer did not
  match
- existing blocks keep their `ccxlogid`. Only the blocks that began with the
  instructions text get a new one, so the first run after upgrading takes the
  usual automatic backup once

### 1.10.0
#### 2026/10/02(Fri)
- skip, in the aggregate output, pairs that are nothing but a Claude Code
  `<task-notification>` block with an empty answer. These blocks are injected
  by Claude Code itself when a background task finishes and contain no words
  from either side of the conversation. A notification with typed text beside
  it, or one whose turn produced an answer, is kept, and `--per-session`
  files keep every pair. On the first run after upgrading, existing blocks of
  this kind leave the aggregate files, so the usual automatic backup is
  taken once

### 1.9.0
#### 2026/08/20(Thu)
- output file names are fixed: `ccxlog.md` / `cclog.md` / `cxlog.md`, their
  `_archive.md` companions, and `cclog_<id>.md` / `cxlog_<id>.md` for
  `--per-session`. The `outputAllFileName` and `outputSessionFilePrefix`
  settings are removed; a config that still sets one stops with an error
  instead of silently writing to the fixed name and leaving the renamed file
  behind unread. Rename existing output to the fixed names, then remove the
  keys. Use `--out` to choose the directory
- do not trigger an automatic Markdown backup when only IDs belonging to the
  latest 10 minutes disappear. `autoBackupGraceMinutes` accepts an integer from
  1 through 60 and changes that minute-only grace period; invalid values are a
  config error. This avoids backups caused while a live question/answer block
  grows and receives a new content-derived ID. The invisible ID marker stores
  Unix milliseconds so the rule is template-independent. Manual backups are unchanged
- keep the everyday aggregate (`ccxlog.md`, `cclog.md`, or `cxlog.md`) small by
  moving older blocks into a matching `_archive.md` file. `recentDays` defaults
  to 8 local calendar days, retaining the same weekday from the previous week
  while keeping active projects practical to open; it accepts any integer of
  1 or greater. If every block fits, no archive file is kept
- treat the recent and archive Markdown as one logical history for automatic
  backup decisions. Moving a block across the date boundary is not a loss; a
  backup is made only when an old `ccxlogid` disappears from both new files,
  and then both old files are preserved together
- record why an automatic backup was taken. Each
  `backup_CCXLOG_md_auto/<stamp>/` folder now also holds a
  `ccxlog-backup-reason.txt` naming the file backed up, the block count before
  and after, every missing `ccxlogid` with the first line of its block, and the
  ccxlog version that made the rewrite. A backup only ever appears because
  blocks were about to be lost, and the folder alone could not say whether a
  source log had expired or an upgrade had merely changed how blocks are formed

### 1.8.0
#### 2026/08/09(Sun)
- add `codex.includeSubagents` and `claude.includeSubagents` — one setting name
  in both sources for whether subagent conversations are rendered. Both default
  to `true`, so Codex output is unchanged and Claude output only gains the
  subagent blocks it used to omit, without moving any existing `ccxlogid`
- `claude.includeSidechain` keeps working as the former name; setting both to
  different values is a config error rather than a silent choice between them
- subagent logs are always backed up by `--backup-jsonl` whatever the setting
  says, and `false` hides Codex subagents only after the inherited-history
  merge, so it reduces what is displayed rather than what is read
- a Codex subagent's reply to the session that spawned it is now progress of
  the block that delegated the work, as a Claude Task result already was. It
  used to open a block of its own, splitting the delegation in two and keeping
  the subagent's words on show even with `codex.includeSubagents: false`

### 1.7.1
#### 2026/08/07(Fri)
- show the name a Codex thread was renamed to instead of the first message it
  happened to start with. Codex records a rename in `session_index.jsonl`
  before its live database catches up, and that database also holds the
  auto-generated title, so the rename record now takes precedence

### 1.7.0
#### 2026/08/06(Thu)
- fix Codex subagent rollouts re-rendering inherited parent conversations as
  new messages, while preserving genuine subagent instructions and replies
- fix Codex subagent attribution by using its own thread id and name and by
  excluding the inherited parent token baseline from its usage totals

### 1.6.0
#### 2026/08/03(Mon)
- add `--watch` for continuous updates, with optional duration
  (`--watch=8h`) and configurable wait time (`watchIntervalSeconds`)
- speed up watch cycles by reusing unchanged log data and reducing retained
  progress data when the template does not use it
- automatically lock the output during writes; watch holds the lock until it
  stops, preventing other ccxlog runs from writing to the same output
- show Codex names assigned with `/rename` in `%SessionName%`

### 1.5.0
#### 2026/07/29(Tue)
- `claude.includeSidechain: true` now also discovers the subagent transcripts
  newer Claude Code writes as separate `<session id>/subagents/*.jsonl` files
  and renders them as additional sessions, closing the gap with cclog
- remove the blanket discovery exclusions (`<out>` and folders named
  `backup_jsonl` / `backup_CCXLOG_md` / `templates`): an explicit
  `extraLogDirs` entry is read wherever it points, so snapshots under
  `<out>/backup_jsonl` can be read back cclog-style
- each source ingests only files in its own format — claude skips Codex
  rollouts and vice versa, unrelated `.jsonl` is skipped by both — so a
  mixed backup dir can be listed in both sources' `extraLogDirs`
- `--backup-jsonl` preserves the root-relative structure (`cc/` mirrors the
  live Claude layout including `subagents/`, which is always backed up;
  `cx/` keeps the date tree), never re-copies files already under its own
  destination, and snapshots read back exactly like the real log folders
- automatic pre-overwrite backups moved to `backup_CCXLOG_md_auto/`,
  separate from manual `--backup-md` copies — a pure pair-loss signal

### 1.4.0
#### 2026/07/27(Mon)
- keep Claude questions that were cancelled before any assistant output and
  then retyped: they are now emitted as answerless pairs instead of being
  silently replaced (2-5% of real questions were disappearing this way).
  Follow-up merging, pair finalization, existing `ccxlogid`s and Codex
  output are all unchanged
- the automatic pre-overwrite backup is now a last line of defense against
  losing pairs: it fires only when a `ccxlogid` present in the old file
  would be missing from the new content, or when the comparison is
  indeterminate (safe side). Rewrites that keep every id — answer updates,
  template changes, insertions, reordering — create no backup. Manual
  `--backup-md` / `--backup-jsonl` are unchanged
- remove the v1.3.0 `amend` machinery, superseded by the id-based rule

### 1.3.0
#### 2026/07/27(Sun)
- speed up log reading substantially (merged mode roughly 35-45% faster on
  real data, up to ~2.4x on large log sets; `-cc` on par with the original
  cclog): 8 MiB chunked line reading, lazy async duplicate-confirmation
  hashing with size/mtime/dev/ino guards, and lazy `%Progress%` rendering
- pre-scan Codex cwd records to skip full parsing of sessions that belong
  to other projects (e.g. 92 -> 9 fully parsed files on real data), with
  conservative fallbacks for unknown formats, missing cwd, I/O errors and
  mid-scan changes; `--verbose` reports `fully read` counts
- output stays byte-identical to 1.2.0 in all three modes
- skip the pre-overwrite backup for rewrites that provably lose no content
  (`amend`), so always-live projects stop accumulating one backup per run

### 1.2.0
#### 2026/07/23(Thu)
- simplify source selection to `-cc` and `-cx`; remove `--claude-only`,
  `--codex-only`, and `--source`
- back up existing output Markdown before every full rewrite while preserving
  no-op and strict append-only updates; this includes template-only changes and
  insertion of earlier Q&A blocks
- remove the configurable `claude.recursive` / `codex.recursive` keys and select
  the correct discovery behavior automatically for each source; legacy keys are
  ignored with a warning
- expand and align the English and Japanese documentation for log discovery,
  backups, file-update behavior, and migration from cclog

### 1.1.0
#### 2026/07/22(Wed)
- replace the `%PairId%` / `ccxid:` identity format with the clearer
  `%CcxlogId%` / `ccxlogid:` format; the formal rendered marker is
  `<!-- ccxlogid:<24 hex digits> -->`
- automatically prepend the formal identity marker to every Q&A block when a
  custom template lacks the exact standalone `<!-- %CcxlogId% -->` line
- remove datetime-based block identity and the old `ccxlog-pair:ccxid:` parser;
  the first 1.1.0 rewrite of an older output is therefore backed up
  conservatively before migration
- remove the duplicated `Source=` field from all six bundled templates while
  keeping the source label in the heading

### 1.0.2
#### 2026/07/22(Wed)
- make `-h` show that the merged, `-cc`, and `-cx` aggregate output filenames
  are independently configurable in `<out>/ccxlog.config.json`, including their
  exact keys and defaults
- add concrete English and Japanese README examples for renaming all three
  aggregate output files

### 1.0.1
#### 2026/07/22(Wed)
- document the difference between
  [`@standard-software/cclog`](https://www.npmjs.com/package/@standard-software/cclog),
  which is dedicated to Claude Code, and ccxlog, which supports both Claude Code
  and Codex CLI
- document `-cc` / `-cx` dedicated output modes and link the
  [GitHub repository](https://github.com/standard-software/ccxlog)

### 1.0.0
#### 2026/07/22(Wed)
- initial release
- merge **Claude Code** (`~/.claude/projects/`) and **Codex CLI**
  (`~/.codex/sessions/`) session logs (JSONL) into one readable Markdown timeline
  - merged aggregate `CCXLOG/ccxlog.md` (default, `both`)
  - `-cc` / `--claude-only` → `cclog.md`, `-cx` / `--codex-only` → `cxlog.md`
    (or `--source both|claude|codex`); the three aggregate files coexist, each
    mode only touching its own file
  - per-session files with `--per-session` (`cclog_<id>.md` / `cxlog_<id>.md`)
- chronological merge across both tools via a stable 8-key comparator, so the
  same logs always render in the same deterministic order
- each block carries its `%Source%` (`ClaudeCode` / `Codex`) so a project driven
  with both tools reads as one history
- **cross-session de-duplication** (aggregate output): pairs a resumed/forked
  Claude session copied verbatim are dropped by message uuid (question, steering
  follow-ups, or answer) — lossless. Codex uuids are per-file positional, so
  Codex pairs are never merged this way. `--per-session` is left un-deduplicated.
- **`includeSubdirectories`** (default `true`): running in `~/work/app` also
  collects nested projects like `~/work/app/frontend`; candidates are confirmed
  against each session's real cwd, so same-prefix siblings (`~/work/app-backup`)
  are never pulled in. Set `false` for exact-path matching only.
- templates (six bundled), placeholder-driven rendering
  - `english.md` (default) / `japanese.md`, plus `-with-progress` and
    `-with-progress-full` variants
  - placeholders: `%DateTime%` / `%Source%` / `%SourceShort%` / `%PairId%` /
    `%SessionId%` / `%SessionName%` / `%Question%` / `%Answer%` / `%Progress%` /
    `%ProgressFull%` / `%Model%` / `%Version%` / `%GitBranch%` / `%Cwd%` /
    `%Tokens%`
  - single-pass rendering: a literal placeholder token appearing inside a
    question or answer is never re-substituted
  - progress verbosity follows the template (`%Progress%` summarized /
    `%ProgressFull%` full input-output JSON + thinking)
- configuration via `CCXLOG/ccxlog.config.json`
  - top-level (both sources): `extraCwds`, `includeSubdirectories`,
    `outputAllFileName`, `template`
  - per-source `claude` / `codex` namespaces: `outputAllFileName`,
    `outputSessionFilePrefix`, `extraLogDirs`, `recursive`, and
    `includeSidechain` (claude) / `includeDeveloperMessages` (codex)
  - unknown keys and wrong types warn and fall back rather than failing silently
- junction / symlink support (resolves the real path and merges logs from both
  encodings)
- smart write
  - no-op when the output is unchanged
  - append-only when the new content is a strict tail extension
  - full overwrite otherwise
- safe writes: plan the write first, take **and verify** a pre-overwrite backup
  before any destructive rewrite (`backup_CCXLOG_md/`), then commit atomically
  with a rename retry; backup folders accumulate and are never pruned
- `--backup-jsonl` / `--backup-md`: standalone backup of the raw source logs /
  exported Markdown, into a per-run `<yyyy-mm-dd_hh-mm-ss>_<hostname>/` folder
- `--lock` / `--force-unlock`: opt-in exclusive lock on the output directory
- `--init-template` to copy the bundled template into the project and rewrite the
  config to use the local copy
