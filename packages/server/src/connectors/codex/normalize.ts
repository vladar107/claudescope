/**
 * Codex rollout → canonical thread normalizer.
 *
 * A Codex session (`rollout-*.jsonl`) spreads its data across record types:
 * `session_meta` (id, cwd), `turn_context` (model, per turn), `response_item`
 * (the transcript), and `event_msg/token_count` (per-turn token usage). This
 * parses one rollout into Claude-shaped `RawEvent[]` — assistant/user turns whose
 * `message.content` carries text / thinking / tool_use / tool_result blocks — so
 * the existing thread assembler and the canonical index row builder both reuse it.
 *
 * Grouping: consecutive assistant-side items (assistant message, reasoning,
 * function_call) coalesce into one assistant turn; user-side items (user message,
 * function_call_output) coalesce into one user turn. `developer` messages (the
 * system prompt) are dropped. Tokens from `token_count` are attributed to the
 * most recent assistant turn.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { AssistantEvent, ContentBlock, MessageUsage, UserEvent } from '@claudescope/shared';

interface CodexLine {
  type?: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}

export interface CodexSession {
  sessionId: string;
  cwd: string;
  gitBranch?: string;
  events: (UserEvent | AssistantEvent)[];
}

/** Mutable per-turn token accumulator (assignable to {@link MessageUsage}). */
interface CodexUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  [k: string]: number;
}
const zeroUsage = (): CodexUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
});

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Strip Codex's redundant `<image …>` / `</image>` placeholder tags. */
function stripImagePlaceholders(text: string): string {
  return text.replace(/<\/?image\b[^>]*>/gi, '').trim();
}

/**
 * Build canonical content blocks from a Codex message's content items: text
 * items become text blocks (with the redundant `<image …>` placeholder — which
 * also embeds a local temp path — stripped), and `input_image`/`output_image`
 * items become image blocks rendered from their `image_url` (usually a base64
 * data URL, so self-contained). The existing frontend renders image blocks.
 */
function messageBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const item = c as Record<string, unknown>;
    const t = str(item.type);
    if (t === 'input_image' || t === 'output_image') {
      const url = str(item.image_url);
      if (url) out.push({ type: 'image', source: { type: 'url', url } });
    } else {
      const text = stripImagePlaceholders(str(item.text));
      if (text) out.push({ type: 'text', text });
    }
  }
  return out;
}

/** Session id from the filename: `rollout-<ts>-<uuid>.jsonl`. */
function sessionIdFromPath(path: string): string {
  const m = basename(path).match(/rollout-.*-([0-9a-f-]{36})\.jsonl$/i);
  return m?.[1] ?? basename(path).replace(/\.jsonl$/, '');
}

/** Parse a Codex rollout file into a Claude-shaped session, or null if unreadable. */
export function parseRollout(path: string): CodexSession | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines: CodexLine[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      lines.push(JSON.parse(t) as CodexLine);
    } catch {
      /* tolerate a corrupt/partial trailing line */
    }
  }

  const meta = lines.find((l) => l.type === 'session_meta')?.payload ?? {};
  const sessionId = str(meta.id) || sessionIdFromPath(path);
  const cwd = str(meta.cwd);
  const git = meta.git as Record<string, unknown> | undefined;
  const gitBranch = git ? str(git.branch) || str(git.ref) || undefined : undefined;

  const events: (UserEvent | AssistantEvent)[] = [];
  let seq = 0;
  let prevUuid: string | null = null;
  let model = '';

  // Open turn buffer; flushed when the conversation side flips.
  let side: 'assistant' | 'user' | null = null;
  let blocks: ContentBlock[] = [];
  let turnTs = '';
  // Holder (not a bare `let`) so reads aren't reset by closure mutation in CFA.
  const usageRef: { current: CodexUsage | null } = { current: null };

  const flush = (): void => {
    if (!side || blocks.length === 0) {
      side = null;
      blocks = [];
      return;
    }
    const uuid = `${sessionId}-${seq++}`;
    const base = { uuid, parentUuid: prevUuid, sessionId, timestamp: turnTs, cwd, isSidechain: false };
    if (side === 'assistant') {
      const usage: MessageUsage = usageRef.current ?? zeroUsage();
      events.push({
        ...base,
        type: 'assistant',
        message: { role: 'assistant', model, content: blocks, usage },
      } as AssistantEvent);
    } else {
      events.push({
        ...base,
        type: 'user',
        message: { role: 'user', content: blocks },
      } as UserEvent);
    }
    prevUuid = uuid;
    side = null;
    blocks = [];
  };

  const open = (next: 'assistant' | 'user', ts: string): void => {
    if (side && side !== next) flush();
    if (!side) {
      side = next;
      turnTs = ts || turnTs;
      if (next === 'assistant') usageRef.current = zeroUsage();
    }
  };

  for (const line of lines) {
    const ts = str(line.timestamp);
    const pl = line.payload ?? {};

    if (line.type === 'turn_context') {
      model = str(pl.model) || model;
      continue;
    }

    if (line.type === 'event_msg' && pl.type === 'token_count') {
      const info = pl.info as Record<string, unknown> | null;
      const last = (info?.last_token_usage ?? null) as Record<string, unknown> | null;
      const acc = usageRef.current;
      if (last && acc) {
        const input = num(last.input_tokens);
        const cached = num(last.cached_input_tokens);
        acc.input_tokens += Math.max(0, input - cached);
        acc.output_tokens += num(last.output_tokens);
        acc.cache_read_input_tokens += cached;
      }
      continue;
    }

    if (line.type !== 'response_item') continue;
    const kind = str(pl.type);

    if (kind === 'message') {
      const role = str(pl.role);
      if (role === 'developer') continue; // system prompt — not conversation
      open(role === 'assistant' ? 'assistant' : 'user', ts);
      for (const b of messageBlocks(pl.content)) blocks.push(b);
    } else if (kind === 'reasoning') {
      open('assistant', ts);
      // Codex persists only encrypted reasoning (no plaintext) — mirror Claude's
      // signature-only thinking block.
      blocks.push({ type: 'thinking', thinking: '', signature: str(pl.encrypted_content) });
    } else if (kind === 'function_call') {
      open('assistant', ts);
      let input: unknown = {};
      try {
        input = JSON.parse(str(pl.arguments));
      } catch {
        input = { arguments: str(pl.arguments) };
      }
      blocks.push({ type: 'tool_use', id: str(pl.call_id), name: str(pl.name), input });
    } else if (kind === 'function_call_output') {
      open('user', ts);
      blocks.push({ type: 'tool_result', tool_use_id: str(pl.call_id), content: str(pl.output) });
    }
  }
  flush();

  return { sessionId, cwd, gitBranch, events };
}

/** A canonical index row (matches the events NDJSON the projection reads). */
export interface CanonicalRow {
  file_path: string;
  session_id: string;
  uuid: string;
  parent_uuid: string | null;
  role: string;
  type: string;
  ts: string;
  cwd: string;
  git_branch: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  service_tier: string | null;
  is_sidechain: boolean;
  tool_use_count: number;
  text_content: string;
}

/** Flatten a parsed session into canonical index rows for one file. */
export function toCanonicalRows(session: CodexSession, filePath: string): CanonicalRow[] {
  return session.events.map((e) => {
    const msg = (e as AssistantEvent | UserEvent).message;
    const content = msg.content;
    const arr = Array.isArray(content) ? content : [];
    const usage = (msg as { usage?: MessageUsage }).usage;
    const text = arr
      .map((b) =>
        b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : '',
      )
      .filter(Boolean)
      .join(' ');
    return {
      file_path: filePath,
      session_id: session.sessionId,
      uuid: e.uuid,
      parent_uuid: e.parentUuid,
      role: msg.role,
      type: e.type,
      ts: e.timestamp,
      cwd: session.cwd,
      git_branch: session.gitBranch ?? null,
      model: (msg as { model?: string }).model ?? null,
      input_tokens: num(usage?.input_tokens),
      output_tokens: num(usage?.output_tokens),
      cache_read_tokens: num(usage?.cache_read_input_tokens),
      cache_write_tokens: 0,
      service_tier: null,
      is_sidechain: false,
      tool_use_count: arr.filter((b) => b.type === 'tool_use').length,
      text_content: text,
    };
  });
}
