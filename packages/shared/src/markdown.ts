/**
 * Render an assembled session (or a slice of one) to Markdown. Pure — no DOM —
 * shared by the web export menu and server-side consumers (MCP/CLI output),
 * which additionally cap tool payloads via `maxToolChars`.
 */

import type { SessionDetailResponse } from './api.js';
import type { SubagentRun, ThreadBlock, ThreadItem } from './thread.js';
import { extOf, lineDiff } from './diff.js';
import { redactText } from './redact.js';

export interface ExportOptions {
  /** Mask home paths and likely secrets before exporting. */
  redact: boolean;
  /** Cap tool inputs/results at this many chars (token frugality); 0/absent = no cap. */
  maxToolChars?: number;
}

/** Truncate `text` to `max` chars with an explicit marker of what was dropped. */
export function truncateText(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated, ${text.length - max} more chars]`;
}

const stringify = (v: unknown): string => {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

/** Per-render string transforms: redaction and tool-payload capping. */
interface Renderers {
  r: (s: string) => string;
  cap: (s: string) => string;
}

/** A unified-diff body (-, +, space prefixes) for an Edit's old→new. */
function diffBody(oldText: string, newText: string): string {
  return lineDiff(oldText, newText)
    .map((l) => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`)
    .join('\n');
}

function fence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

function toolToMd(tool: Extract<ThreadBlock, { kind: 'tool' }>, { r, cap }: Renderers): string {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const path = typeof input.file_path === 'string' ? r(input.file_path) : undefined;
  const head = `**⚙ ${tool.name}**${path ? ` \`${path}\`` : ''}`;
  const resultText = tool.result
    ? tool.result.content.map((b) => (b.type === 'text' ? b.text : stringify(b))).join('\n').trim()
    : '';

  switch (tool.name) {
    case 'Edit':
      return `${head}\n\n${fence('diff', cap(r(diffBody(String(input.old_string ?? ''), String(input.new_string ?? '')))))}`;
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const body = edits
        .map((e) => {
          const er = (e ?? {}) as Record<string, unknown>;
          return fence('diff', cap(r(diffBody(String(er.old_string ?? ''), String(er.new_string ?? '')))));
        })
        .join('\n\n');
      return `${head}\n\n${body}`;
    }
    case 'Write':
      return `${head}\n\n${fence(extOf(path) ?? '', cap(r(String(input.content ?? ''))))}`;
    case 'Bash': {
      const cmd = fence('bash', cap(r(String(input.command ?? ''))));
      return resultText ? `${head}\n\n${cmd}\n\n${fence('', cap(r(resultText)))}` : `${head}\n\n${cmd}`;
    }
    case 'Read':
      return `${head}\n\n${fence(extOf(path) ?? '', cap(r(resultText)))}`;
    default: {
      const inMd = fence('json', cap(r(stringify(tool.input))));
      return resultText ? `${head}\n\n${inMd}\n\n${fence('', cap(r(resultText)))}` : `${head}\n\n${inMd}`;
    }
  }
}

function blockToMd(block: ThreadBlock, rr: Renderers): string | null {
  switch (block.kind) {
    case 'text': {
      const t = rr.r(block.text).trim();
      return t || null;
    }
    case 'thinking':
      return block.thinking.trim() ? `> 💭 ${rr.r(block.thinking).replace(/\n/g, '\n> ')}` : null;
    case 'tool':
      return toolToMd(block, rr);
    case 'attachment':
      return '_[attachment]_';
  }
}

function turnToMd(item: ThreadItem, rr: Renderers): string {
  const who = item.role === 'user' ? '👤 User' : `🤖 Assistant${item.model ? ` · ${item.model}` : ''}`;
  const body = item.blocks
    .map((b) => blockToMd(b, rr))
    .filter((s): s is string => s !== null)
    .join('\n\n');
  return `### ${who}\n\n${body}`;
}

function subagentToMd(run: SubagentRun, rr: Renderers): string {
  const turns = run.thread
    .map((t) => turnToMd(t, rr))
    .join('\n\n')
    .replace(/^### /gm, '#### '); // demote one level inside a subagent
  return `### 🧩 Subagent · ${run.agentType} — ${rr.r(run.description || run.agentId)}\n\n${turns}`;
}

function renderers(opts: ExportOptions): Renderers {
  const max = opts.maxToolChars ?? 0;
  return {
    r: (s: string) => (opts.redact ? redactText(s) : s),
    cap: (s: string) => truncateText(s, max),
  };
}

/** Render a slice of thread items to Markdown turns (no session header). */
export function threadItemsToMarkdown(items: ThreadItem[], opts: ExportOptions): string {
  const rr = renderers(opts);
  return items.map((t) => turnToMd(t, rr)).join('\n\n');
}

/** Render a session detail response to a Markdown document. */
export function sessionToMarkdown(data: SessionDetailResponse, opts: ExportOptions): string {
  const { meta, thread, subagents } = data;
  const rr = renderers(opts);
  const { r } = rr;

  const head: string[] = [`# ${r(meta.title || 'Untitled session')}`];
  const facts = [
    meta.gitBranch ? `**Branch:** ${r(meta.gitBranch)}` : '',
    meta.models.length ? `**Models:** ${meta.models.join(', ')}` : '',
    `**Tokens:** ${meta.totalTokens.toLocaleString()}`,
    `**Cost:** $${meta.totalCostUsd.toFixed(2)}`,
  ].filter(Boolean);
  head.push(facts.join(' · '));
  head.push(`${meta.startedAt} → ${meta.endedAt}`);
  if (meta.prUrl) head.push(`**PR:** ${meta.prUrl}`);
  if (opts.redact) head.push('_Exported with redaction (paths & likely secrets masked)._');

  const parts = [head.join('\n\n'), '---', ...thread.map((t) => turnToMd(t, rr))];
  if (subagents.length > 0) {
    parts.push('---', '## Subagents', ...subagents.map((s) => subagentToMd(s, rr)));
  }
  return parts.join('\n\n') + '\n';
}
