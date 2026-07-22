import fs from 'node:fs/promises';
import path from 'node:path';
import type { CcxlogConfig } from '../../lib/config.js';
import { encodeCwd, getClaudeProjectsDir, sha256HexBytes, canonicalPathString, canonicalPath, isPathWithin, buildRelativeId } from '../../lib/pathUtils.js';
import type { SourceAdapter, RootRef, DiscoveredFile, SessionData, FilterContext } from '../adapter.js';
import { readJsonl } from './jsonlReader.js';
import { buildPairs, extractSessionName } from './pairBuilder.js';

function sessionIdFor(rootDir: string, filePath: string): string {
  const rel = path.relative(rootDir, filePath).replace(/\.jsonl$/, '');
  return rel.replace(/[\\/]/g, '__');
}

// Read a representative cwd for a Claude project folder by scanning its session
// files (top level only) until an entry carrying a `cwd` is found. A Claude
// project folder maps to a single cwd (the folder name is that cwd, encoded),
// so the first cwd found is authoritative. Used to confirm a prefix-matched
// subdirectory candidate is genuinely nested under the project (not a
// same-prefix sibling). Mirrors cclog's firstLoggedCwd. Returns undefined if
// no cwd is present anywhere.
async function firstLoggedCwd(logDir: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = (await fs.readdir(logDir)).filter(n => n.endsWith('.jsonl')).sort();
  } catch {
    return undefined;
  }
  for (const name of names) {
    let entries;
    try {
      ({ entries } = await readJsonl(path.join(logDir, name)));
    } catch {
      continue;
    }
    for (const e of entries) {
      const cwd = (e as { cwd?: unknown }).cwd;
      if (typeof cwd === 'string' && cwd) return cwd;
    }
  }
  return undefined;
}

export const claudeAdapter: SourceAdapter = {
  id: 'claude',
  label: 'ClaudeCode',
  shortLabel: 'cc',

  candidateRoots(projectPath: string, realProjectPath: string, outDir: string, cfg: CcxlogConfig): RootRef[] {
    const projectsDir = getClaudeProjectsDir();
    const standardDirs = Array.from(new Set([
      path.join(projectsDir, encodeCwd(projectPath)),
      path.join(projectsDir, encodeCwd(realProjectPath)),
      ...cfg.extraCwds.map(c => path.join(projectsDir, encodeCwd(path.resolve(projectPath, c)))),
    ]));
    const roots: RootRef[] = standardDirs.map(dir => ({
      dir,
      origin: 'standard' as const,
      stableRootKey: 'std',
      recursive: false,
    }));
    for (const spec of cfg.claude.extraLogDirs) {
      // Relative extraLogDirs resolve against <out>, not cwd (§4.2).
      const dir = path.resolve(outDir, spec.dir);
      const stableRootKey = spec.key ?? sha256HexBytes(canonicalPathString(dir), 12);
      roots.push({ dir, origin: 'extra', stableRootKey, recursive: false });
    }
    return roots;
  },

  // Nested-project roots (§ includeSubdirectories, cclog parity). Claude stores
  // each project at ~/.claude/projects/<encoded cwd>/, and a subdirectory's
  // encoded name is always <encoded parent>-<rest> (every non-alphanumeric char,
  // including '/', collapses to '-'). So nested projects are found by the
  // encodeCwd(base)+'-' folder-name prefix. That lossy encoding ALSO matches a
  // sibling like <project>-backup, so each candidate's real cwd (read from its
  // log) is confirmed with isPathWithin before it is adopted. Adopted folders
  // become standard-origin RootRefs (stableRootKey 'std'), same as the exact
  // project roots — Claude's filterSession returns belongs:true, so their
  // sessions are kept verbatim.
  async subdirRoots(projectPath: string, realProjectPath: string, _cfg: CcxlogConfig): Promise<RootRef[]> {
    const projectsDir = getClaudeProjectsDir();
    const bases = Array.from(new Set([projectPath, realProjectPath]));
    const exact = new Set(bases.map(b => encodeCwd(b)));
    const prefixes = bases.map(b => encodeCwd(b) + '-');
    let names: string[];
    try {
      names = await fs.readdir(projectsDir);
    } catch {
      return [];
    }
    const canonBases = await Promise.all(bases.map(canonicalPath));
    const roots: RootRef[] = [];
    for (const name of names.sort()) {
      if (exact.has(name)) continue;
      if (!prefixes.some(pre => name.startsWith(pre))) continue;
      const dir = path.join(projectsDir, name);
      try {
        if (!(await fs.stat(dir)).isDirectory()) continue;
      } catch {
        continue;   // vanished between readdir and stat
      }
      const cwd = await firstLoggedCwd(dir);
      if (!cwd) continue;
      const canonCwd = await canonicalPath(cwd);
      if (!canonBases.some(b => isPathWithin(canonCwd, b))) continue;   // sibling — reject
      roots.push({ dir, origin: 'standard', stableRootKey: 'std', recursive: false });
    }
    return roots;
  },

  outputAllFileName(cfg: CcxlogConfig): string { return cfg.claude.outputAllFileName; },
  sessionFilePrefix(cfg: CcxlogConfig): string { return cfg.claude.outputSessionFilePrefix; },

  async readSession(file: DiscoveredFile, cfg: CcxlogConfig): Promise<SessionData> {
    const r = await readJsonl(file.filePath);
    const pairs = buildPairs(r.entries, { includeSidechain: cfg.claude.includeSidechain });
    return {
      source: 'claude',
      // Claude session id is ALWAYS path-based (log-internal sessionId would
      // collide between a main session and its subagent).
      sessionId: sessionIdFor(file.root.dir, file.filePath),
      sessionName: extractSessionName(r.entries),
      sessionCwd: '',
      jsonlPath: file.filePath,
      sourceFileRelativeId: buildRelativeId('claude', file.root.origin, file.root.stableRootKey, file.root.dir, file.filePath),
      fromExplicitRoot: file.root.origin === 'extra',
      fileContentHash: r.fileContentHash,
      eventIdStreamHash: r.eventIdStreamHash,
      allPairs: pairs,
      skippedLines: r.skippedLines,
    };
  },

  // Claude attributes whole files to a project by directory name, so every
  // pair is kept; the session always belongs.
  async filterSession(s: SessionData, _cfg: CcxlogConfig, _ctx: FilterContext) {
    return { pairs: s.allPairs, belongs: true };
  },
};
