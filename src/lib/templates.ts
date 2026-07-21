// Default pair-block template, built into the binary so ccxlog runs without
// any config file. Matches templates/english.md. Users override per-project
// via ccxlog.config.json's "template" field (resolution order: §4.5).
//
// Placeholders (case-sensitive, surrounded by %): %DateTime% %Source%
// %SourceShort% %PairId% %SessionId% %SessionName% %Question% %Progress%
// %ProgressFull% %Answer% %Model% %Version% %GitBranch% %Cwd% %Tokens%.

export const DEFAULT_TEMPLATE = `<!-- ccxlog-pair:%PairId% -->
# %DateTime%   [%Source%] Session:%SessionName%:%SessionId%
Source=%Source% Model=%Model% Version=%Version%
Branch=%GitBranch% Cwd=%Cwd%
Tokens=%Tokens%
## Question
%Question%

<!--
## Answer
%Answer%
-->

----------------------------------------

`;

export const PROGRESS_PLACEHOLDER = '%Progress%';
export const PROGRESS_FULL_PLACEHOLDER = '%ProgressFull%';

export function hasBothProgress(tpl: string): boolean {
  return tpl.includes(PROGRESS_FULL_PLACEHOLDER) && tpl.includes(PROGRESS_PLACEHOLDER);
}

export function templateHasSource(tpl: string): boolean {
  return tpl.includes('%Source%');
}

// Every placeholder renderTemplate knows about (§7.2). Anything else shaped
// like %Name% is left verbatim in the output and reported once via --verbose.
export const KNOWN_PLACEHOLDERS = new Set([
  'DateTime', 'Source', 'SourceShort', 'PairId', 'SessionId', 'SessionName',
  'Question', 'Progress', 'ProgressFull', 'Answer', 'Model', 'Version',
  'GitBranch', 'Cwd', 'Tokens',
]);

const PLACEHOLDER_RE = /%([A-Za-z][A-Za-z0-9]*)%/g;

// Unknown %Name% placeholders present in the template, de-duplicated in first-
// seen order. Used to warn (§7.2) without failing generation.
export function unknownPlaceholders(tpl: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of tpl.matchAll(PLACEHOLDER_RE)) {
    const name = m[1];
    if (KNOWN_PLACEHOLDERS.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Defang HTML-comment tokens so a template wrapping a value inside `<!-- -->`
// isn't broken by a literal `-->` (or `<!--`) in the value (§7.2, 4 vars).
export function defangComment(s: string): string {
  return s.replaceAll('-->', '-- >').replaceAll('<!--', '<! --');
}

const CONTENT_VARS = new Set(['Question', 'Answer', 'Progress', 'ProgressFull']);

// Literal placeholder replacement (§7.2). A SINGLE left-to-right pass over the
// template replaces each known %Name% with its value, so a value that itself
// contains `%Answer%` (or any other placeholder) is NEVER re-scanned — the
// sequential multi-pass version could cross-inject one variable's value into
// another (§7.2, §12.2). The replacer returns the literal value via a function,
// so `$&` / `$1` / `$$` in the value are not interpreted. Content vars
// (Question/Answer/Progress/ProgressFull) are comment-defanged; unknown
// %Name% placeholders are left verbatim (§7.2) for a --verbose warning.
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return whole; // unknown: keep verbatim
    const rawVal = vars[name];
    return CONTENT_VARS.has(name) ? defangComment(rawVal) : rawVal;
  });
}
