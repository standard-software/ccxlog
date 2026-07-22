import path from 'node:path';
import type { CcxlogConfig } from '../../lib/config.js';
import { getCodexSessionsDir, sha256HexBytes, canonicalPathString, canonicalPath, isPathWithin, buildRelativeId } from '../../lib/pathUtils.js';
import { extractCwd } from '../../lib/metaExtractor.js';
import type { SourceAdapter, RootRef, DiscoveredFile, SessionData, FilterContext } from '../adapter.js';
import { readJsonl } from './jsonlReader.js';
import { buildPairs, extractSessionName } from './pairBuilder.js';

export const codexAdapter: SourceAdapter = {
  id: 'codex',
  label: 'Codex',
  shortLabel: 'cx',

  candidateRoots(_projectPath: string, _realProjectPath: string, outDir: string, cfg: CcxlogConfig): RootRef[] {
    const roots: RootRef[] = [{
      dir: getCodexSessionsDir(),
      origin: 'standard',
      stableRootKey: 'std',
      recursive: true,
    }];
    for (const spec of cfg.codex.extraLogDirs) {
      // Relative extraLogDirs resolve against <out>, not cwd (§4.2).
      const dir = path.resolve(outDir, spec.dir);
      const stableRootKey = spec.key ?? sha256HexBytes(canonicalPathString(dir), 12);
      roots.push({ dir, origin: 'extra', stableRootKey, recursive: true });
    }
    return roots;
  },

  outputAllFileName(cfg: CcxlogConfig): string { return cfg.codex.outputAllFileName; },
  sessionFilePrefix(cfg: CcxlogConfig): string { return cfg.codex.outputSessionFilePrefix; },

  async readSession(file: DiscoveredFile, cfg: CcxlogConfig): Promise<SessionData> {
    const r = await readJsonl(file.filePath, cfg.codex.includeDeveloperMessages);
    const rolloutBase = path.basename(file.filePath).replace(/\.jsonl$/, '');
    return {
      source: 'codex',
      sessionId: r.sessionId || rolloutBase,
      sessionName: r.sessionName || extractSessionName(r.entries),
      sessionCwd: r.sessionCwd ?? '',
      jsonlPath: file.filePath,
      sourceFileRelativeId: buildRelativeId('codex', file.root.origin, file.root.stableRootKey, file.root.dir, file.filePath),
      fromExplicitRoot: file.root.origin === 'extra',
      fileContentHash: r.fileContentHash,
      eventIdStreamHash: r.eventIdStreamHash,
      allPairs: buildPairs(r.entries),
      skippedLines: r.skippedLines,
    };
  },

  // Codex mixes every project into one tree, so keep only the pairs whose
  // turn-level cwd matches the project. Files under an explicit extraLogDirs
  // root are trusted verbatim (no cwd filter). With includeSubdirectories
  // (default true, cclog parity), a cwd NESTED under the project is also kept
  // — the exact-match set is widened to an isPathWithin check against the
  // canonical project path. A same-prefix sibling (project-backup) fails the
  // within-check, so it is never pulled in.
  async filterSession(s: SessionData, _cfg: CcxlogConfig, ctx: FilterContext) {
    // Files under an explicit extraLogDirs root are trusted verbatim (§5.2);
    // use the structured flag rather than parsing the relative-id string.
    if (s.fromExplicitRoot) return { pairs: s.allPairs, belongs: true };
    const wanted = async (raw: string): Promise<boolean> => {
      const canon = await canonicalPath(raw);
      if (ctx.wantedCwds.has(canon)) return true;
      return ctx.includeSubdirectories && isPathWithin(canon, ctx.canonicalProjectPath);
    };
    const pairs = [];
    for (const p of s.allPairs) {
      const cwd = extractCwd(p);
      if (cwd && await wanted(cwd)) pairs.push(p);
    }
    let belongs = pairs.length > 0;
    if (!belongs && s.sessionCwd && await wanted(s.sessionCwd)) belongs = true;
    return { pairs, belongs };
  },
};
