import { archiveFileName } from './recentArchive.js';
import type { Source, SourceMode } from './types.js';

// Every file name ccxlog writes is fixed (v1.9.0). They used to be
// configurable, and the cost of that outweighed the use: a renamed output left
// the file under the old name on disk, still carrying ccxlog's owner marker but
// no longer read, no longer compared for lost blocks and no longer picked up by
// --backup-md — an invisible copy that only looked like a spare. Fixed names
// also mean "read CCXLOG/ccxlog.md" stays true in every document, script and
// agent instruction that refers to the output. Use --out to choose the
// directory instead; that covers what renaming was reached for.
export const AGGREGATE_FILE_NAME: Record<SourceMode, string> = {
  both: 'ccxlog.md',
  claude: 'cclog.md',
  codex: 'cxlog.md',
};

// Derived rather than spelled out, so the `_archive` convention has one
// definition shared with the split itself.
export const ARCHIVE_FILE_NAME: Record<SourceMode, string> = {
  both: archiveFileName(AGGREGATE_FILE_NAME.both),
  claude: archiveFileName(AGGREGATE_FILE_NAME.claude),
  codex: archiveFileName(AGGREGATE_FILE_NAME.codex),
};

// --per-session output: <prefix><session id>.md
export const SESSION_FILE_PREFIX: Record<Source, string> = {
  claude: 'cclog_',
  codex: 'cxlog_',
};

// Every name ccxlog owns in the output directory, for the enumerations that
// need the whole set (--backup-md, self-exclusion).
export const ALL_AGGREGATE_FILE_NAMES: string[] = [
  ...Object.values(AGGREGATE_FILE_NAME),
  ...Object.values(ARCHIVE_FILE_NAME),
];
