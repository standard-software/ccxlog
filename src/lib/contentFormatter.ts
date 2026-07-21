import type { ContentBlock, MessageContent } from './types.js';

export function toBlocks(content: MessageContent): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

export function contentHasOnlyToolResults(content: MessageContent): boolean {
  const blocks = toBlocks(content);
  if (blocks.length === 0) return false;
  return blocks.every(b => b.type === 'tool_result');
}

export function formatUserText(content: MessageContent): string {
  const blocks = toBlocks(content);
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
      parts.push((b as { text: string }).text);
    } else if (b.type === 'image') {
      parts.push('[Image]');
    } else if (b.type === 'tool_result') {
      parts.push(formatToolResultSummary(b));
    } else {
      parts.push(`[${b.type}]`);
    }
  }
  return parts.join('\n').replace(/\s+$/g, '');
}

export function extractLastAssistantText(content: MessageContent): string | null {
  const blocks = toBlocks(content);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
      return (b as { text: string }).text;
    }
  }
  return null;
}

export function extractNonFinalAssistantTexts(content: MessageContent): string[] {
  const blocks = toBlocks(content);
  let lastTextIdx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === 'text') { lastTextIdx = i; break; }
  }
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (i === lastTextIdx) continue;
    const b = blocks[i];
    if (b.type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
      out.push((b as { text: string }).text);
    }
  }
  return out;
}

export function extractToolUses(content: MessageContent): ContentBlock[] {
  return toBlocks(content).filter(b => b.type === 'tool_use');
}

export function extractToolResults(content: MessageContent): ContentBlock[] {
  return toBlocks(content).filter(b => b.type === 'tool_result');
}

interface AnyToolUse { name?: unknown; input?: unknown }
interface AnyToolResult { content?: unknown }

export function formatToolUseSummary(block: ContentBlock, includeFull = false): string {
  const tu = block as unknown as AnyToolUse;
  const name = typeof tu.name === 'string' ? tu.name : 'unknown';
  if (includeFull) {
    return `[Tool: ${name}] ${safeJson(tu.input)}`;
  }
  const hint = summarizeToolInput(tu.input);
  return hint ? `[Tool: ${name} ${hint}]` : `[Tool: ${name}]`;
}

export function formatToolResultSummary(block: ContentBlock, includeFull = false): string {
  const tr = block as unknown as AnyToolResult;
  const c = tr.content;
  let text: string;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    text = c.map(x => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object' && 'text' in x && typeof (x as { text: unknown }).text === 'string') {
        return (x as { text: string }).text;
      }
      return safeJson(x);
    }).join(' ');
  } else {
    text = safeJson(c);
  }
  if (includeFull) return `[ToolResult] ${text}`;
  const head = text.split('\n')[0].slice(0, 80);
  return `[ToolResult: ${head}${text.length > head.length ? '...' : ''}]`;
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const keys = ['file_path', 'path', 'pattern', 'command', 'url', 'query'];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string') {
      return v.length > 80 ? v.slice(0, 80) + '...' : v;
    }
  }
  return '';
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    if (!s) return String(v);
    return s.length > 200 ? s.slice(0, 200) + '...' : s;
  } catch {
    return String(v);
  }
}
