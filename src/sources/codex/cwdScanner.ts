import { forEachLine } from '../../lib/lineStream.js';
import {
  canonicalPath, canonicalPathString, fileSnapshot, isPathWithin, sameSnapshot,
} from '../../lib/pathUtils.js';
import type { PathDep } from '../../lib/pathUtils.js';
import { extractCodexCwdRecord } from './jsonlReader.js';
import type { DiscoveredFile, FilterContext, PrefilterResult } from '../adapter.js';

const PREFILTER_CONCURRENCY = 8;

// Codex cwd prefilter.
//
// Codex mixes the logs of every project into one shared tree
// (~/.codex/sessions), so ccxlog used to fully parse files belonging to
// unrelated projects. Here we cheaply scan only the lines that carry a cwd
// (session_meta / turn_context) and exclude files that CANNOT belong to this
// project before the full parse.
//
// Structure: scanning (scanCodexCwds -> CwdScanResult) is separated from the
// verdict (mayBelong). A scanner can be injected into mayBelong (default
// scanCodexCwds) purely for testability — it lets tests reproduce a scan
// failure, or an append landing between "scan finished" and "post-scan
// re-check", deterministically and over the real code path. No
// timing-specific hook belongs in the production API.
//
// Safety design (a file may be excluded only when it definitely does not
// belong):
// - Anything under an explicit extraLogDirs root is kept unconditionally, per
//   the existing trust contract (§5.2).
// - cwd extraction goes through extractCodexCwdRecord(), shared with the normal
//   reader, so format knowledge lives in one place and a future format change
//   cannot update only one of the two.
// - A file with no cwd at all is not excluded; it falls back to normal
//   analysis, keeping behaviour exactly as it was before the prefilter existed.
// - A file is also not excluded when an unknown record type carried something
//   that looks like a payload.cwd (the unknownFormat guard). If Codex later
//   introduces a new cwd-bearing record type, failing to recognise its cwd here
//   must not fail toward exclusion.
//   Known limit: an unknown format that puts cwd somewhere other than directly
//   under payload (at the record's top level, or deeply nested) escapes this
//   guard. Even then, a file with no known-format cwd falls back as "no cwd
//   observed", so the only residual risk is a file mixing known-format
//   unrelated cwds with an unknown-format matching cwd.
// - A file whose scan failed (I/O error and the like) is not excluded either
//   and falls back to normal analysis, so a transient read failure neither
//   drops a session from the output nor crashes the whole CLI at the prefilter
//   stage.
// - The snapshot (size/mtime/dev/ino) is compared before and after the scan; a
//   file appended to or replaced mid-scan is not excluded but falls back. This
//   covers the live-append window where a turn for the target project is
//   appended right after we read only unrelated cwds.
//   Known limit: an in-place edit that keeps the same inode and size and
//   restores the original mtime defeats the snapshot comparison (all four
//   attributes match). Closing it would need something like a fingerprint of
//   the scanned bytes, and reading every file in full would cancel out the
//   speedup this prefilter exists for. Ordinary log writing (appending) never
//   produces such an edit; producing one takes deliberate external mtime
//   restoration. Design decision, also recorded in SPEEDUP-NOTES §7.
// - The scan uses the optimised shared reader forEachLine (8MB chunks) and
//   stops as soon as a belonging cwd is found (early return). A file of the
//   target project itself is usually settled by the session_meta on line 1, so
//   "reading a belonging file twice" nearly disappears.

// Does an already-canonicalised cwd belong? Same logic as filterSession's
// decision. Equal `canon` implies an equal result: wantedCwds,
// includeSubdirectories and canonicalProjectPath are all part of the
// incremental re-parse cache's fingerprint, so a change to any of them throws
// the whole cache away. That is why reusing an exclusion outcome only has to
// ask "is canon the same as last cycle?".
function canonBelongs(canon: string, ctx: FilterContext): boolean {
  if (ctx.wantedCwds.has(canon)) return true;
  return ctx.includeSubdirectories && isPathWithin(canon, ctx.canonicalProjectPath);
}

// A synchronous preliminary check that skips realpath. When it returns true the
// file belongs and the scan may stop right there (a false positive on the KEEP
// side is harmless — filterSession makes the final call). A false never
// excludes: after the scan finishes, cwdBelongs (with realpath) decides
// precisely, which is what catches cases where symlinks make the string forms
// disagree.
function quickBelongs(rawCwd: string, ctx: FilterContext): boolean {
  const canon = canonicalPathString(rawCwd);
  if (ctx.wantedCwds.has(canon)) return true;
  return ctx.includeSubdirectories && isPathWithin(canon, ctx.canonicalProjectPath);
}

// The explicit boundary of a scan result: these four values are everything
// mayBelong decides on.
// - cwds: the cwds observed (from known-format records only; truncated when
//   matchedFast)
// - recognized: whether a known-format record (session_meta / turn_context) was
//   seen. The production keep/exclude decision uses the presence of cwds and
//   unknownFormat; recognized is observational, for tests and diagnostics, and
//   is currently not part of the verdict.
// - unknownFormat: whether an unknown record type carried a payload.cwd-looking
//   string
// - matchedFast: whether quickBelongs settled "belongs" and cut the scan short
export interface CwdScanResult {
  cwds: string[];
  recognized: boolean;
  unknownFormat: boolean;
  matchedFast: boolean;
}

// Lightly scan one file for cwd information only (it makes no keep/exclude
// decision). Uses the same forEachLine and the same format knowledge
// (extractCodexCwdRecord) as the normal reader. I/O errors propagate to the
// caller rather than being swallowed here — deciding to fall back is
// mayBelong's job.
export async function scanCodexCwds(
  filePath: string,
  ctx: FilterContext,
): Promise<CwdScanResult> {
  const cwds = new Set<string>();
  let recognized = false;
  let unknownFormat = false;
  let matchedFast = false;
  await forEachLine(filePath, (line) => {
    // Most lines carry no cwd. A substring gate avoids JSON.parse for them
    // (a JSON line with a cwd key always contains '"cwd"').
    if (!line.includes('"cwd"')) return;
    let event: unknown;
    try { event = JSON.parse(line); } catch { return; }
    const record = extractCodexCwdRecord(event);
    if (!record.recognized) {
      // An unknown record type with a payload.cwd-looking string may be a
      // future format, so we give up the grounds for excluding this file
      // (the unknownFormat guard).
      const payload = (event as Record<string, unknown>).payload;
      if (payload && typeof payload === 'object'
        && typeof (payload as Record<string, unknown>).cwd === 'string') {
        unknownFormat = true;
      }
      return;
    }
    recognized = true;
    if (!record.cwd) return;
    if (quickBelongs(record.cwd, ctx)) {
      matchedFast = true;
      return false;   // early return: it belongs, so the rest is not read
    }
    cwds.add(record.cwd);
    return;
  });
  return { cwds: [...cwds], recognized, unknownFormat, matchedFast };
}

export type CwdScanner = typeof scanCodexCwds;

/**
 * The prefilter verdict for one file.
 * - `{ keep: true }`: do not exclude (it may belong, or there is not enough to
 *   decide on).
 * - `{ keep: false, cwdDeps }`: exclude. `cwdDeps` lists the "raw cwd -> this
 *   cycle's canonical resolution" pairs the exclusion rested on. The
 *   incremental re-parse cache re-verifies those resolutions to decide whether
 *   `prefiltered` may be reused next cycle, which is how a re-pointed link
 *   target is detected (see analysisCache.ts).
 */
export type PrefilterVerdict =
  | { keep: true; cwdDeps?: undefined }
  | { keep: false; cwdDeps: PathDep[] };

const KEEP: PrefilterVerdict = { keep: true };

// Can this file belong to the project? `keep: false` is allowed only when at
// least one cwd was observed, none of them belongs to the project, and the file
// did not change during the scan.
// The scanner is injectable (default scanCodexCwds) so tests can wrap the real
// scan and deterministically reproduce a scan failure, or an append landing
// between "real scan finished" and "post-scan re-check", over the real path.
export async function mayBelong(
  file: DiscoveredFile,
  ctx: FilterContext,
  scanner: CwdScanner = scanCodexCwds,
): Promise<PrefilterVerdict> {
  // An explicit root is always kept without looking at cwd (the §5.2 trust contract).
  if (file.root.origin === 'extra') return KEEP;
  // Pre-scan snapshot. A file we cannot stat (removed just before the scan, say)
  // is kept undecided, leaving normal analysis to handle it as it always has.
  const before = await fileSnapshot(file.filePath);
  if (!before) return KEEP;
  let scan: CwdScanResult;
  try {
    scan = await scanner(file.filePath, ctx);
  } catch {
    // Scan failure (I/O error and the like) -> do not exclude, fall back to
    // normal analysis. Without this catch, Promise.all would abort the whole CLI.
    return KEEP;
  }
  if (scan.matchedFast) return KEEP;
  // Post-scan snapshot check: a file appended to or replaced during the scan may
  // already have outgrown a scan result that saw unrelated cwds only, so it is
  // not excluded. The matchedFast early return needs no check — it keeps the file.
  const after = await fileSnapshot(file.filePath);
  if (!after || !sameSnapshot(before, after)) return KEEP;
  // No cwd at all (including unknown formats) -> do not exclude, fall back to
  // normal analysis. The legacy path also decides belonging from cwd, so
  // behaviour matches the pre-prefilter version.
  if (scan.unknownFormat || scan.cwds.length === 0) return KEEP;
  // Only when excluding do we carry back the resolutions the decision used
  // (a file settled as belonging cuts the scan short, so there is no dependency
  // worth recording on the `keep: true` side).
  const cwdDeps: PathDep[] = [];
  for (const cwd of scan.cwds) {
    const canon = await canonicalPath(cwd);
    if (canonBelongs(canon, ctx)) return KEEP;
    cwdDeps.push({ raw: cwd, canon });
  }
  return { keep: false, cwdDeps };
}

// Overlap filesystem reads under a concurrency limit rather than opening every
// file at once. Results are written by index so discovery order survives,
// preserving the deterministic output order downstream.
export async function prefilterCodexFiles(
  files: DiscoveredFile[],
  ctx: FilterContext,
): Promise<PrefilterResult> {
  // Initialised to the KEEP side. Workers fill every index so this is normally
  // overwritten, but should one ever be missed the default must not fail toward
  // exclusion.
  const verdicts = new Array<PrefilterVerdict>(files.length).fill(KEEP);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= files.length) return;
      verdicts[index] = await mayBelong(files[index], ctx);
    }
  };
  const count = Math.min(PREFILTER_CONCURRENCY, files.length);
  await Promise.all(Array.from({ length: count }, () => worker()));
  const excludedCwdDeps = new Map<string, PathDep[]>();
  files.forEach((f, index) => {
    const v = verdicts[index];
    if (!v.keep) excludedCwdDeps.set(f.filePath, v.cwdDeps);
  });
  return { passed: files.filter((_, index) => verdicts[index].keep), excludedCwdDeps };
}
