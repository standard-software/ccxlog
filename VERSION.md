# ccxlog

## Version

### 1.4.0
#### 2026/07/27(Mon)
- keep Claude questions that were cancelled before any assistant output and
  then retyped (the log records the retype as a sibling fork of the cancelled
  question): the cancelled question is now emitted as its own answerless pair
  instead of being silently replaced by the retyped one, and chains of
  consecutive cancellations (A -> B -> C) keep every question. Real-data
  measurement showed 2-5% of questions were disappearing this way, including
  meaningful development instructions
- unchanged around that fix: follow-up messages typed while a turn has not
  answered yet are still merged into the same pair, a question is still
  finalized by the next one once any assistant output exists, existing pairs
  keep their `ccxlogid`s, and Codex output is unaffected (verified on frozen
  real-data snapshots: the old id set is a subset of the new one, existing
  blocks are byte-identical, only cancelled-question pairs are added)
- redefine the automatic pre-overwrite Markdown backup as a last line of
  defense against losing conversation pairs, not an archive of every past
  Markdown: it now fires **only when at least one `ccxlogid` present in the
  old file would be missing from the new content** (e.g. pairs vanishing
  because their source JSONL expired, a discovery/config mistake, or a
  de-duplication change)
- still back up, on the safe side, when the comparison is indeterminate: no
  valid `ccxlogid` in the old file, malformed or duplicate ids, or new
  content that fails to parse; refusing to overwrite ownership-unconfirmed
  files and the manual `--backup-md` / `--backup-jsonl` actions are unchanged
- stop creating backups for rewrites that keep every id: answer updates of a
  still-running turn, template changes, insertion of late-confirmed pairs at
  an earlier point of the timeline, and reordering. The first regeneration
  after upgrading only adds the previously-dropped cancelled questions, so it
  creates no backup either
- remove the v1.3.0 `amend` classification and its character-subsequence
  checker, superseded by the simpler id-based rule (net code reduction)

### 1.3.0
#### 2026/07/27(Sun)
- speed up log reading substantially (merged mode roughly 35-45% faster on
  real data, and up to ~2.4x on large log sets); `-cc` now runs on par with
  the original cclog
- read JSONL logs in 8 MiB chunks with linear line splitting (was 64 KiB
  chunks with per-line re-slicing)
- compute whole-file duplicate-confirmation hashes lazily and asynchronously,
  only when a duplicate candidate cannot be resolved by cheaper checks;
  guard against files changed between parse and hash (size/mtime/dev/ino)
- skip full parsing of Codex session files that verifiably belong to other
  projects by pre-scanning their cwd records (e.g. 92 -> 9 fully parsed files
  on real data); unknown record formats, files without cwd, scan I/O errors,
  and files modified during the scan conservatively fall back to full parsing
- build `%Progress%` / `%ProgressFull%` only when the template references
  them
- report `fully read` file counts for the Codex prefilter under `--verbose`
- keep output byte-identical to 1.2.0 in all three modes (verified on frozen
  real-data snapshots on Windows and WSL)
- stop taking a pre-overwrite backup for rewrites that provably lose no
  content (reported as `amend`): when the previous run rendered a pair whose
  session was still answering, the next run fills it in and appends new
  pairs; projects with always-live sessions no longer accumulate one backup
  per run. Any rewrite that deletes, edits, or reorders existing content is
  still backed up first.

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
