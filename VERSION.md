# ccxlog

**Language:** [Japanese/日本語](VERSION_Japanese.md)

## Version

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
