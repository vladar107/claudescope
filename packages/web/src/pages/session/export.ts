/**
 * Export a session to Markdown (client-side, from the already-loaded detail).
 * Pure — no DOM — so it's easy to unit-test.
 */

import type { SessionDetailResponse, SubagentRun, ThreadBlock, ThreadItem } from '@claudescope/shared';
import { lineDiff } from '../../components/diff.js';
import { extOf } from '../../components/diff.js';

export interface ExportOptions {
  /** Mask home paths and likely secrets before exporting. */
  redact: boolean;
}

// Home-dir paths -> `~` (drops the username segment too).
const HOME_RE = /(?:\/Users|\/home|[A-Z]:\\Users)\/[^/\\\s"'`)]+/g;
// Conservative, prefix-anchored secret patterns (avoid false positives).
const SECRET_RES: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{16,}/g, '«redacted-key»'],
  [/(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/g, '«redacted-token»'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '«redacted-token»'],
  [/AKIA[0-9A-Z]{16}/g, '«redacted-aws-key»'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '«redacted-slack-token»'],
  [/Bearer\s+[A-Za-z0-9._-]{16,}/g, 'Bearer «redacted»'],
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '«redacted-private-key»'],
];

/** Mask home paths and likely secrets in a string. */
export function redactText(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_RES) out = out.replace(re, rep);
  out = out.replace(HOME_RE, '~');
  return out;
}

const stringify = (v: unknown): string => {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

/** A unified-diff body (-, +, space prefixes) for an Edit's old→new. */
function diffBody(oldText: string, newText: string): string {
  return lineDiff(oldText, newText)
    .map((l) => `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`)
    .join('\n');
}

function fence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

function toolToMd(tool: Extract<ThreadBlock, { kind: 'tool' }>, r: (s: string) => string): string {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const path = typeof input.file_path === 'string' ? r(input.file_path) : undefined;
  const head = `**⚙ ${tool.name}**${path ? ` \`${path}\`` : ''}`;
  const resultText = tool.result
    ? tool.result.content.map((b) => (b.type === 'text' ? b.text : stringify(b))).join('\n').trim()
    : '';

  switch (tool.name) {
    case 'Edit':
      return `${head}\n\n${fence('diff', r(diffBody(String(input.old_string ?? ''), String(input.new_string ?? ''))))}`;
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const body = edits
        .map((e) => {
          const er = (e ?? {}) as Record<string, unknown>;
          return fence('diff', r(diffBody(String(er.old_string ?? ''), String(er.new_string ?? ''))));
        })
        .join('\n\n');
      return `${head}\n\n${body}`;
    }
    case 'Write':
      return `${head}\n\n${fence(extOf(path) ?? '', r(String(input.content ?? '')))}`;
    case 'Bash': {
      const cmd = fence('bash', r(String(input.command ?? '')));
      return resultText ? `${head}\n\n${cmd}\n\n${fence('', r(resultText))}` : `${head}\n\n${cmd}`;
    }
    case 'Read':
      return `${head}\n\n${fence(extOf(path) ?? '', r(resultText))}`;
    default: {
      const inMd = fence('json', r(stringify(tool.input)));
      return resultText ? `${head}\n\n${inMd}\n\n${fence('', r(resultText))}` : `${head}\n\n${inMd}`;
    }
  }
}

function blockToMd(block: ThreadBlock, r: (s: string) => string): string | null {
  switch (block.kind) {
    case 'text': {
      const t = r(block.text).trim();
      return t || null;
    }
    case 'thinking':
      return block.thinking.trim() ? `> 💭 ${r(block.thinking).replace(/\n/g, '\n> ')}` : null;
    case 'tool':
      return toolToMd(block, r);
    case 'attachment':
      return '_[attachment]_';
  }
}

function turnToMd(item: ThreadItem, r: (s: string) => string): string {
  const who = item.role === 'user' ? '👤 User' : `🤖 Assistant${item.model ? ` · ${item.model}` : ''}`;
  const body = item.blocks
    .map((b) => blockToMd(b, r))
    .filter((s): s is string => s !== null)
    .join('\n\n');
  return `### ${who}\n\n${body}`;
}

function subagentToMd(run: SubagentRun, r: (s: string) => string): string {
  const turns = run.thread
    .map((t) => turnToMd(t, r))
    .join('\n\n')
    .replace(/^### /gm, '#### '); // demote one level inside a subagent
  return `### 🧩 Subagent · ${run.agentType} — ${r(run.description || run.agentId)}\n\n${turns}`;
}

/** Render a session detail response to a Markdown document. */
export function sessionToMarkdown(data: SessionDetailResponse, opts: ExportOptions): string {
  const { meta, thread, subagents } = data;
  const r = (s: string) => (opts.redact ? redactText(s) : s);

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

  const parts = [head.join('\n\n'), '---', ...thread.map((t) => turnToMd(t, r))];
  if (subagents.length > 0) {
    parts.push('---', '## Subagents', ...subagents.map((s) => subagentToMd(s, r)));
  }
  return parts.join('\n\n') + '\n';
}
