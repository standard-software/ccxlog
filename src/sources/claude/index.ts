import fs from 'node:fs/promises';
import path from 'node:path';
import type { CcxlogConfig } from '../../lib/config.js';
import { encodeCwd, sha256HexBytes, canonicalPathString, canonicalPath, isPathWithin, buildRelativeId } from '../../lib/pathUtils.js';
import type { SourceAdapter, RootRef, DiscoveredFile, SessionData, FilterContext, ReadResume } from '../adapter.js';
import { applyProgressRetention } from '../../lib/progressData.js';
import type { Pair } from '../../lib/types.js';
import type { LogHome } from '../../lib/logHomes.js';
import { forEachLine } from '../../lib/lineStream.js';
import { readClaudeSession, type ClaudeReadState } from './jsonlReader.js';

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
//
// This runs for every candidate folder on every watch cycle, so it reads only
// as far as the first cwd (usually the first few lines) instead of parsing whole
// sessions, and remembers which file answered. A logged cwd never changes once
// written, so the remembered answer stays valid for as long as that file exists.
const firstCwdMemo = new Map<string, { name: string; cwd: string }>();

async function firstLoggedCwd(logDir: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = (await fs.readdir(logDir)).filter(n => n.endsWith('.jsonl')).sort();
  } catch {
    return undefined;
  }
  const memo = firstCwdMemo.get(logDir);
  if (memo && names.includes(memo.name)) return memo.cwd;
  for (const name of names) {
    let found: string | undefined;
    try {
      await forEachLine(path.join(logDir, name), (line) => {
        if (!line.includes('"cwd"')) return;
        try {
          const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
          if (typeof cwd === 'string' && cwd) { found = cwd; return false; }
        } catch {
          // A broken line is skipped, as the full reader would.
        }
      });
    } catch {
      continue;
    }
    if (found) {
      firstCwdMemo.set(logDir, { name, cwd: found });
      return found;
    }
  }
  firstCwdMemo.delete(logDir);
  return undefined;
}

export const claudeAdapter: SourceAdapter = {
  id: 'claude',
  label: 'ClaudeCode',
  shortLabel: 'cc',

  candidateRoots(projectPath: string, realProjectPath: string, outDir: string, cfg: CcxlogConfig, homes: LogHome[]): RootRef[] {
    // Every log home keeps the project under the same encoded name in its own
    // projects/, whichever account wrote it.
    const forHome = (home: LogHome): RootRef[] => {
      const projectsDir = path.join(home.dir, 'projects');
      const standardDirs = Array.from(new Set([
        path.join(projectsDir, encodeCwd(projectPath)),
        path.join(projectsDir, encodeCwd(realProjectPath)),
        ...cfg.extraCwds.map(c => path.join(projectsDir, encodeCwd(path.resolve(projectPath, c)))),
      ]));
      return standardDirs.map(dir => ({
        dir,
        origin: 'standard' as const,
        stableRootKey: home.key,
        recursive: false,
        scanSubagentDirs: true,
        home: home.key,
      }));
    };
    const roots: RootRef[] = homes.filter(h => h.found === 'default').flatMap(forHome);
    for (const spec of cfg.claude.extraLogDirs) {
      // Relative extraLogDirs resolve against <out>, not cwd (§4.2).
      const dir = path.resolve(outDir, spec.dir);
      const stableRootKey = spec.key ?? sha256HexBytes(canonicalPathString(dir), 12);
      roots.push({ dir, origin: 'extra', stableRootKey, recursive: false, scanSubagentDirs: true });
      // (scanSubagentDirs is unconditional: see RootRef.scanSubagentDirs.)
    }
    roots.push(...homes.filter(h => h.found !== 'default').flatMap(forHome));
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
  async subdirRoots(projectPath: string, realProjectPath: string, _cfg: CcxlogConfig, homes: LogHome[]): Promise<RootRef[]> {
    const bases = Array.from(new Set([projectPath, realProjectPath]));
    const exact = new Set(bases.map(b => encodeCwd(b)));
    const prefixes = bases.map(b => encodeCwd(b) + '-');
    const canonBases = await Promise.all(bases.map(canonicalPath));
    const roots: RootRef[] = [];
    for (const home of homes) {
      const projectsDir = path.join(home.dir, 'projects');
      let names: string[];
      try {
        names = await fs.readdir(projectsDir);
      } catch {
        continue;
      }
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
        roots.push({ dir, origin: 'standard', stableRootKey: home.key, recursive: false, scanSubagentDirs: true, home: home.key });
      }
    }
    return roots;
  },


  async readSession(file: DiscoveredFile, cfg: CcxlogConfig, resume?: ReadResume): Promise<SessionData> {
    // Both conversations are ALWAYS built, whatever `includeSubagents` says: the
    // display filter runs much later, on UnifiedPairs (spec §8 step 7). Parsing
    // is where the two streams are told apart, and nowhere else — see
    // buildPairsSplit() for why they are not built as one interleaved stream.
    //
    // The per-pair finishing steps go in `prepare`, which the reader applies
    // once to every pair, whether it was just parsed or is a closed pair kept
    // from an earlier read (jsonlReader.ts).
    const prepare = (pairs: Pair[]): void => {
      // A transcript under `<session id>/subagents/` is a subagent conversation
      // in its entirety, whether or not its records carry `isSidechain` (spec
      // §4.2, §6.1). The directory is the authority there; the flag is the
      // authority inside an ordinary session log.
      if (file.subagentDir) for (const p of pairs) p.isSubagent = true;
      // Progress data is discarded AFTER the pairs are built — that is, after
      // slash-command bodies have been recovered (see the rationale in
      // lib/progressData.ts).
      applyProgressRetention(pairs, cfg);
    };
    const { read: r, state } = await readClaudeSession(file.filePath, prepare, resume?.state as ClaudeReadState | undefined);
    if (resume) {
      resume.state = state;
      resume.resumed = r.resumed;
    }
    const pairs = [...r.main, ...r.subagent];
    return {
      source: 'claude',
      // Claude session id is ALWAYS path-based (log-internal sessionId would
      // collide between a main session and its subagent).
      sessionId: sessionIdFor(file.root.dir, file.filePath),
      sessionName: r.sessionName,
      sessionCwd: '',
      jsonlPath: file.filePath,
      sourceFileRelativeId: buildRelativeId('claude', file.root.origin, file.root.stableRootKey, file.root.dir, file.filePath),
      fromExplicitRoot: file.root.origin === 'extra',
      fileContentHash: r.fileContentHash,
      eventIdStream: r.eventIdStream,
      allPairs: pairs,
      skippedLines: r.skippedLines,
      formatRecognized: r.formatRecognized,
      logHome: file.root.home,
    };
  },

  // Claude attributes whole files to a project by directory name, so every
  // pair is kept; the session always belongs.
  async filterSession(s: SessionData, _cfg: CcxlogConfig, _ctx: FilterContext) {
    return { pairs: s.allPairs, belongs: true };
  },
};
