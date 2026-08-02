// Incremental re-parse cache for watch mode.
//
// A watch repeats "process -> wait -> process", and between cycles only a
// handful of files normally change. This keeps the previous cycle's analysis in
// the watch process's MEMORY so later cycles re-read only what changed.
//
// The overriding invariant: with the cache enabled, the output must be
// BYTE-IDENTICAL to a cold run (cycle 1) over the same inputs. Four design
// rules keep it that way.
//
// 1. Identity is decided by the file's four attributes ALONE (`size`,
//    `mtimeMs`, `dev`, `ino`) via the existing `FileSnapshot` / `sameSnapshot()`
//    (pathUtils.ts). Including size catches an append that lands inside one
//    mtime tick on coarse-granularity filesystems.
// 2. The snapshot is taken BEFORE reading (at discovery-time stat) and taken
//    AGAIN just before the entry is stored. Only a file whose four attributes
//    still match is cached, which makes the postcondition explicit: a cached
//    snapshot always describes the state the cached content was read from. A
//    file appended to or replaced mid-read is used for THIS cycle's output but
//    not cached — the next cycle re-reads it, which is the safe direction.
//    Only files actually re-read this cycle are re-stat'd, so an unchanged
//    cycle adds no stat calls at all.
// 3. If any premise of the analysis changed, the whole cache is dropped
//    (`useFingerprint()`). When config, target project, mode or anything else
//    that can make the same file analyse differently changes, we do not reason
//    about partial validity — we discard everything.
// 4. Exclusion outcomes re-verify the external path resolution they were based
//    on, every cycle (`pathDeps`). The four attributes, the config and the
//    target project can all be unchanged while a symlink/junction on the way to
//    a cwd inside a Codex log is re-pointed, which flips whether the session
//    belongs. Sessions that contributed to the output (`used`) still hold their
//    raw data and re-run `filterSession()` each cycle, so they follow along on
//    their own; exclusion outcomes (`prefiltered` / `dropped`) hold no raw data
//    and cannot. So we carry the "raw cwd -> canonical" resolutions used for the
//    decision as a lightweight dependency, re-resolve them each cycle, and reuse
//    the outcome only on an exact match (a mismatch or a failed resolution means
//    re-scan — again the safe direction).
//
// Only what reading a file yields is cached:
// - `outcome`: how the file was treated this cycle (see `CachedOutcome`),
//   including the verdict of Codex's cwd prefilter ("this file belongs to
//   another project"). Unchanged files are not re-scanned.
// - `session`: the result of `readSession()` (the full parse). ONLY files that
//   contributed to the output (`outcome === 'used'`) keep it. Files that were
//   read and then discarded (not this source's format, or not part of the
//   target project) remember just the outcome and release the raw data, so
//   retained memory matches what a single run still holds once it leaves the
//   loop.
// `filterSession()` (in-memory pair selection) is deliberately NOT cached and
// re-runs every cycle for files whose session is retained: it touches no disk,
// caching it would buy nothing, and extra decision inputs would only widen the
// surface the invariant has to be verified across.
//
// Nothing is persisted to disk; the cache dies with the process. Memory is kept
// on par with what a single run already builds: one Map is reused across
// cycles, a re-read file overwrites its entry in place (releasing the old
// analysis immediately), and files that stop being discovered are dropped at
// the end of the cycle.
import { fileSnapshot, pathDepsUnchanged, sameSnapshot } from './pathUtils.js';
import type { PathDep } from './pathUtils.js';
import type { DiscoveredFile, SessionData } from '../sources/adapter.js';

export interface AnalysisCacheStats {
  /** Discovered files re-scanned and fully re-parsed this cycle (cache miss). */
  reparsed: number;
  /** Discovered files reused from the cache this cycle (four attributes match). */
  reused: number;
}

/**
 * What became of one file when it was scanned and read. The next cycle
 * reproduces this outcome verbatim. Only `used` carries the raw analysis.
 * - `prefiltered`: Codex's cwd prefilter judged it to belong to another
 *   project. It was never fully parsed, so there is nothing to retain.
 * - `unrecognized`: fully parsed, but not one record of this source's own
 *   format was found (§format detection, v1.5.0). Read and thrown away, so no
 *   raw data is kept.
 * - `dropped`: fully parsed, but it does not belong to the target project
 *   (`filterSession` returned zero pairs and `belongs=false`). Even a single
 *   run discards this once it leaves the loop, so it is not retained.
 * - `used`: contributed to the output. Only this case carries the full parse.
 */
export type CachedOutcome = 'prefiltered' | 'unrecognized' | 'dropped' | 'used';

/**
 * What the caller supplies at registration time (`snapshot` / `rootKey` are
 * added by the cache). It is a discriminated union so the type system pins down
 * two invariants:
 * - "never hold raw data for a file that did not contribute to the output" —
 *   `{ outcome: 'dropped', session }` cannot be written, so a regression that
 *   accidentally carries raw data forward fails to compile.
 * - "a file excluded on a cwd decision must be registered together with that
 *   dependency" — `pathDeps` is mandatory, so forgetting it also fails to
 *   compile. An empty array means "excluded without depending on any external
 *   path resolution" (e.g. a session that became `dropped` while holding no cwd
 *   at all).
 */
export type CachedEntry =
  | { outcome: 'used'; session: SessionData; pathDeps?: undefined }
  | { outcome: 'unrecognized'; session?: undefined; pathDeps?: undefined }
  | { outcome: 'prefiltered' | 'dropped'; session?: undefined; pathDeps: PathDep[] };

export type CachedFile = CachedEntry & {
  /** The four attributes taken before reading; the next cycle's identity basis. */
  snapshot: NonNullable<DiscoveredFile['snapshot']>;
  /** Identity of the discovery root (material for `sourceFileRelativeId` / `sessionId`). */
  rootKey: string;
};

export interface AnalysisCache {
  /** Start of a cycle: reset the counters and the "seen this cycle" key set. */
  beginCycle(): void;
  /** Drop every entry if the premises (config, target, mode) differ from last cycle. */
  useFingerprint(fingerprint: string): void;
  /**
   * Return the entry when the four attributes and the root match — and, for an
   * exclusion outcome, when re-resolving `pathDeps` still agrees. Any single
   * mismatch discards it and falls back to re-analysis.
   */
  get(key: string, file: DiscoveredFile): Promise<CachedFile | undefined>;
  /**
   * Register a file once it has been scanned and read. The four attributes are
   * taken again right before storing, and the entry is kept only if they still
   * match discovery time. This runs only for files re-read this cycle, so an
   * unchanged cycle adds no stat calls.
   */
  set(key: string, file: DiscoveredFile, entry: CachedEntry): Promise<void>;
  /** End of a cycle: delete entries for files that were not discovered this time. */
  endCycle(): void;
  stats(): AnalysisCacheStats;
}

/** Cache key. The same path analysed as a different source is a different result. */
export function cacheKey(sourceId: string, file: DiscoveredFile): string {
  return `${sourceId}\0${file.filePath}`;
}

// Identity of the discovery root. `sourceFileRelativeId` and Claude's
// `sessionId` are derived from the root's dir / origin / stableRootKey, so the
// same file discovered through a different root cannot reuse the analysis.
function rootKeyOf(file: DiscoveredFile): string {
  return `${file.root.origin}\0${file.root.stableRootKey}\0${file.root.dir}`;
}

export function createAnalysisCache(): AnalysisCache {
  const entries = new Map<string, CachedFile>();
  let fingerprint: string | null = null;
  let seen = new Set<string>();
  let reparsed = 0;
  let reused = 0;

  return {
    beginCycle(): void {
      seen = new Set();
      reparsed = 0;
      reused = 0;
    },

    useFingerprint(next: string): void {
      if (fingerprint !== null && fingerprint !== next) entries.clear();
      fingerprint = next;
    },

    async get(key: string, file: DiscoveredFile): Promise<CachedFile | undefined> {
      seen.add(key);
      const hit = entries.get(key);
      // A file we could not snapshot (removed between discovery and stat, say)
      // gives us nothing to compare, so it is always re-read.
      const same = hit !== undefined
        && file.snapshot !== undefined
        && hit.rootKey === rootKeyOf(file)
        && sameSnapshot(hit.snapshot, file.snapshot)
        // Extra check for exclusion outcomes only (design rule 4). `pathDeps`
        // exists on `prefiltered` / `dropped` alone, so the `used` /
        // `unrecognized` majority adds not one re-resolution on an unchanged
        // cycle. Even for exclusions, canonicalPath()'s per-cycle memo means
        // the real realpath cost is one call per distinct cwd per cycle.
        && (hit.pathDeps === undefined || await pathDepsUnchanged(hit.pathDeps));
      if (!same) {
        if (hit !== undefined) entries.delete(key);   // release the stale analysis at once
        reparsed++;
        return undefined;
      }
      reused++;
      return hit;
    },

    async set(key: string, file: DiscoveredFile, entry: CachedEntry): Promise<void> {
      seen.add(key);
      // Without a snapshot there is nothing for the next cycle to match, so the
      // file is never cached in the first place.
      if (file.snapshot === undefined) { entries.delete(key); return; }
      // Re-check after reading. A file appended to or replaced while it was
      // being scanned may have produced an analysis of a half-written state, so
      // it is not cached — this cycle's output uses it, the next cycle re-reads.
      const after = await fileSnapshot(file.filePath);
      if (after === null || !sameSnapshot(file.snapshot, after)) { entries.delete(key); return; }
      entries.set(key, { ...entry, snapshot: file.snapshot, rootKey: rootKeyOf(file) });
    },

    endCycle(): void {
      for (const key of entries.keys()) {
        if (!seen.has(key)) entries.delete(key);
      }
    },

    stats(): AnalysisCacheStats {
      return { reparsed, reused };
    },
  };
}
