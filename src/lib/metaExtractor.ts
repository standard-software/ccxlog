import type { Pair, AssistantEntry, Source, TokenTotals } from './types.js';

// Parsed JSONL entries carry more fields than the narrow interfaces declare
// (model, usage, version, gitBranch, cwd, …). They survive JSON.parse
// untouched, so we read them through a permissive record cast.
type Raw = Record<string, unknown>;

function raw(e: unknown): Raw {
  return (e && typeof e === 'object' ? e : {}) as Raw;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// "8730" -> "8,730". Locale-independent so exported Markdown is byte-stable.
function comma(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function assistantEntries(pair: Pair): AssistantEntry[] {
  const list: AssistantEntry[] = [];
  for (const e of pair.progressEntries) {
    if (e.type === 'assistant') list.push(e as AssistantEntry);
  }
  if (pair.finalAssistantEntry) list.push(pair.finalAssistantEntry);
  return list;
}

const SYNTHETIC = '<synthetic>';

export function extractModel(pair: Pair): string {
  const asst = assistantEntries(pair);
  for (let i = asst.length - 1; i >= 0; i--) {
    const m = raw(asst[i].message).model;
    if (typeof m === 'string' && m && m !== SYNTHETIC) return m;
  }
  return '';
}

// version / gitBranch / cwd live at the top level of every entry. The
// question entry is the natural anchor; fall back through the rest.
function anchorField(pair: Pair, key: string): string {
  const candidates: unknown[] = [
    pair.questionEntry,
    ...pair.additionalQuestionEntries,
    pair.finalAssistantEntry,
    ...pair.progressEntries,
  ];
  for (const e of candidates) {
    if (!e) continue;
    const v = raw(e)[key];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

export function extractVersion(pair: Pair): string { return anchorField(pair, 'version'); }
export function extractGitBranch(pair: Pair): string { return anchorField(pair, 'gitBranch'); }
export function extractCwd(pair: Pair): string { return anchorField(pair, 'cwd'); }

// Sum message.usage across every assistant turn in the pair. A single answer
// often spans several API calls (thinking, tool_use, then text), so per-pair
// totals require accumulating them all. Fields the source never reports are
// left undefined so a known 0 is distinguishable (§6.1).
export function extractTokenTotals(pair: Pair, source: Source): TokenTotals {
  const asst = assistantEntries(pair);
  // Start with every field undefined. The defined-zero baseline is only laid
  // down when we actually meet a usage entry, so a pair with NO usage at all
  // stays all-undefined and formatTokens renders `Tokens=` (empty) — matching
  // cclog for token-less pairs (§7.2). A usage entry that happens to be all
  // zeros still yields defined zeros, preserving the known-0 vs absent-usage
  // distinction (§6.1).
  const t: TokenTotals = {};
  let sawUsage = false;
  for (const a of asst) {
    const usage = raw(a.message).usage;
    if (!usage || typeof usage !== 'object') continue;
    if (!sawUsage) {
      sawUsage = true;
      if (source === 'claude') {
        t.input = 0; t.output = 0; t.cacheRead = 0; t.cacheWrite5m = 0; t.cacheWrite1h = 0;
      } else {
        t.input = 0; t.output = 0; t.cacheRead = 0; t.reasoning = 0;
      }
    }
    const u = usage as Raw;
    t.input = (t.input ?? 0) + num(u.input_tokens);
    t.output = (t.output ?? 0) + num(u.output_tokens);
    if (source === 'claude') {
      t.cacheRead = (t.cacheRead ?? 0) + num(u.cache_read_input_tokens);
      const cc = u.cache_creation;
      if (cc && typeof cc === 'object') {
        t.cacheWrite5m = (t.cacheWrite5m ?? 0) + num((cc as Raw).ephemeral_5m_input_tokens);
        t.cacheWrite1h = (t.cacheWrite1h ?? 0) + num((cc as Raw).ephemeral_1h_input_tokens);
      } else {
        t.cacheWrite5m = (t.cacheWrite5m ?? 0) + num(u.cache_creation_input_tokens);
      }
    } else {
      t.cacheRead = (t.cacheRead ?? 0) + num(u.cache_read_input_tokens) + num(u.cached_input_tokens);
      t.reasoning = (t.reasoning ?? 0) + num(u.reasoning_output_tokens);
    }
  }
  return t;
}

export function formatTokens(t: TokenTotals): string {
  const cacheWriteDefined = t.cacheWrite5m !== undefined || t.cacheWrite1h !== undefined;
  const cacheWrite = (t.cacheWrite5m ?? 0) + (t.cacheWrite1h ?? 0);
  // Empty ONLY when every field is undefined — a genuine, defined 0 must still
  // render as "in 0, out 0, …" (§7.2 undefined-vs-0 rule). A sum===0 shortcut
  // wrongly blanked defined-zero Codex/Claude pairs.
  const anyDefined = t.input !== undefined || t.output !== undefined || t.cacheRead !== undefined
    || cacheWriteDefined || t.reasoning !== undefined;
  if (!anyDefined) return '';

  const parts: string[] = [];
  if (t.input !== undefined) parts.push(`in ${comma(t.input)}`);
  if (t.output !== undefined) parts.push(`out ${comma(t.output)}`);
  if (t.cacheRead !== undefined) parts.push(`cache read ${comma(t.cacheRead)}`);
  if (cacheWriteDefined) parts.push(`cache write ${comma(cacheWrite)}`);
  // Show reasoning whenever the source defines it (Codex always does), matching
  // the undefined-vs-0 rule the other fields use (§6.1); no >0 special case.
  if (t.reasoning !== undefined) parts.push(`reasoning ${comma(t.reasoning)}`);
  return parts.join(', ');
}
