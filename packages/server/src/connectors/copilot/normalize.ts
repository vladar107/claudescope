/**
 * GitHub Copilot CLI session → canonical thread normalizer.
 *
 * Source layout: `~/.copilot/session-state/<uuid>/events.jsonl` — an event-sourced
 * stream (Junie/pi-shaped) where each line is
 * `{type, data, id, timestamp, parentId}`. The transcript is spread across record
 * types: `session.start` carries cwd/branch/repository, `session.model_change`
 * the model, `assistant.message` the text + tool calls (+ encrypted reasoning),
 * `tool.execution_complete` the tool results, and `session.shutdown` the ONLY
 * token counts (session-level — there is no per-message usage). The sibling
 * `workspace.yaml` carries the session title; `files/<displayName>` holds persisted
 * attachments (screenshots) when saving is enabled.
 *
 * This parses one session into Claude-shaped `RawEvent[]` so the thread assembler
 * and the canonical index-row builder both reuse it (mirrors `pi`/`opencode`).
 *
 * Notable quirks:
 *  - **Tokens only in `session.shutdown`** → attached to the LAST assistant turn;
 *    `message.id` is never set, so the cost path counts the single token-bearing
 *    row exactly once. A session with no shutdown (crash/kill/running) has zero cost.
 *  - **Reasoning is encrypted** (`reasoningOpaque`) → empty `thinking` block carrying
 *    the opaque blob as `signature` (renders empty, like Codex).
 *  - **Screenshots**: the `events.jsonl` attachment path is a dead `$TMPDIR` copy, but
 *    when saving is enabled the bytes live at `files/<displayName>`. Resolved to a
 *    base64 `ImageBlock` ONLY in `loadSession` (`resolveImages`); the index keeps the
 *    inline `[📷 …]` marker that Copilot embeds in the message text.
 *  - **Files-changed**: an `edit`/`create`/`write` tool is mapped to a canonical
 *    `Edit`/`Write` block ONLY when it actually succeeded (a granted, successful
 *    `tool.execution_complete`); a denied/failed attempt passes through under its raw
 *    name so it shows in-thread but never reaches the Files-changed tab.
 *
 * STRICTLY READ-ONLY with respect to ~/.copilot — files are only ever read.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type {
  AssistantEvent,
  ContentBlock,
  MessageUsage,
  ToolResultBlock,
  UserEvent,
} from '@claudescope/shared';
import { toolNamesCsv } from '../tool-names.js';

export interface CopilotSession {
  sessionId: string;
  cwd: string;
  branch: string | null;
  title: string;
  events: (UserEvent | AssistantEvent)[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Copilot stores token counts as `{tokenCount: N}` buckets. */
const tokenCount = (v: unknown): number => num(rec(v).tokenCount);

/**
 * `session.shutdown.data.tokenDetails` → canonical usage. The breakdown is
 * `input` (non-cached) + `cache_read` + `output`; `cache_write` is absent today
 * (0). Reasoning is already folded into `output` by Copilot (OpenAI semantics),
 * so we don't add `reasoningTokens` — that would double-count.
 */
function shutdownUsage(data: Record<string, unknown>): MessageUsage {
  const td = rec(data.tokenDetails);
  return {
    input_tokens: tokenCount(td.input),
    output_tokens: tokenCount(td.output),
    cache_read_input_tokens: tokenCount(td.cache_read),
    cache_creation_input_tokens: tokenCount(td.cache_write),
  };
}

const zeroUsage = (): MessageUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

/**
 * Map a Copilot tool request to a canonical `tool_use` block. File-mutating tools
 * (`edit`/`create`/`write`) only become canonical `Edit`/`Write` — which the
 * Files-changed extractor (`changeset.ts`) keys off — when the call actually
 * succeeded; otherwise they pass through under their raw name so a denied/failed
 * attempt is visible in-thread but doesn't count as a file change. Read-only tools
 * (`view`→`Read`, `bash`→`Bash`) map unconditionally. Unknown tools pass through.
 */
function toolUseBlock(
  name: string,
  args: Record<string, unknown>,
  id: string,
  succeeded: boolean,
): ContentBlock {
  switch (name) {
    case 'edit':
      if (succeeded) {
        return {
          type: 'tool_use',
          id,
          name: 'Edit',
          input: { file_path: str(args.path), old_string: str(args.old_str), new_string: str(args.new_str) },
        };
      }
      break;
    case 'create':
    case 'write':
      if (succeeded) {
        return {
          type: 'tool_use',
          id,
          name: 'Write',
          input: { file_path: str(args.path), content: str(args.content) },
        };
      }
      break;
    case 'view':
      return {
        type: 'tool_use',
        id,
        name: 'Read',
        input: { file_path: str(args.path), offset: args.offset, limit: args.limit },
      };
    case 'bash':
      return {
        type: 'tool_use',
        id,
        name: 'Bash',
        input: { command: str(args.command), timeout: args.timeout, description: str(args.description) },
      };
  }
  // failed/denied edit, sql, ask_user, fetch_*, or any unknown tool → generic render
  return { type: 'tool_use', id, name, input: args };
}

/** Cap an inline-embedded screenshot so a stray huge file can't bloat the
 *  session-detail payload / exhaust memory when base64-encoded. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Resolve a persisted attachment (`files/<displayName>`) to a base64 `ImageBlock`.
 * The `events.jsonl` attachment `path` is a deleted `$TMPDIR` copy, so we resolve by
 * `displayName` (basename only — never escape the `files/` dir). Returns null for a
 * non-image, or when the bytes weren't saved (screenshot-saving off) — the inline
 * `[📷 …]` marker in the message text already conveys the attachment in that case.
 */
function resolveImage(sessionDir: string, displayName: string): ContentBlock | null {
  const name = basename(displayName);
  const mime = IMAGE_MIME[extname(name).toLowerCase()];
  if (!name || !mime) return null;
  try {
    const full = join(sessionDir, 'files', name);
    if (statSync(full).size > MAX_IMAGE_BYTES) return null; // don't inline an oversized file
    const data = readFileSync(full).toString('base64');
    return { type: 'image', source: { type: 'base64', media_type: mime, data } };
  } catch {
    return null;
  }
}

/** A `user.message` → canonical blocks: the literal text (which already carries the
 *  `[📷 name]` marker) plus any resolvable saved-image attachments. */
function userBlocks(
  data: Record<string, unknown>,
  sessionDir: string,
  resolveImages: boolean,
): ContentBlock[] {
  const out: ContentBlock[] = [];
  const text = str(data.content);
  if (text) out.push({ type: 'text', text });
  if (resolveImages) {
    const atts = Array.isArray(data.attachments) ? data.attachments : [];
    for (const a of atts) {
      const att = rec(a);
      if (str(att.type) === 'file') {
        const img = resolveImage(sessionDir, str(att.displayName));
        if (img) out.push(img);
      }
    }
  }
  return out;
}

interface CopilotEvent {
  type?: string;
  data?: unknown;
  id?: string;
  timestamp?: string;
  parentId?: string | null;
}

/** Minimal `workspace.yaml` reader — only a few scalar keys are needed. */
function readWorkspaceYaml(path: string): { name?: string; cwd?: string; branch?: string } {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const get = (key: string): string | undefined => {
    const m = raw.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm'));
    return m?.[1]?.replace(/^['"]|['"]$/g, '');
  };
  return { name: get('name'), cwd: get('cwd'), branch: get('branch') };
}

/**
 * Parse a Copilot `events.jsonl` into a Claude-shaped session, or null if
 * unreadable. `resolveImages` (loadSession only) reads saved attachment bytes off
 * disk; the index path leaves it off to avoid reading images it never embeds.
 */
export function parseCopilotSession(
  path: string,
  opts: { resolveImages?: boolean } = {},
): CopilotSession | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines: CopilotEvent[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      lines.push(JSON.parse(t) as CopilotEvent);
    } catch {
      /* tolerate a corrupt/partial trailing line */
    }
  }

  const sessionDir = dirname(path);
  const ws = readWorkspaceYaml(join(sessionDir, 'workspace.yaml'));
  let sessionId = basename(sessionDir) || path;
  let cwd = '';
  let branch: string | null = null;

  // Pass 1: session identity (session.start) + per-tool outcome (success/denied).
  // The result/denial is needed when emitting a tool_use, which precedes its
  // tool.execution_complete in the stream — so collect outcomes up front.
  const resultById = new Map<string, { content: string; isError: boolean }>();
  for (const ev of lines) {
    const d = rec(ev.data);
    if (ev.type === 'session.start') {
      const ctx = rec(d.context);
      if (str(d.sessionId)) sessionId = str(d.sessionId);
      if (str(ctx.cwd)) cwd = str(ctx.cwd);
      if (str(ctx.branch)) branch = str(ctx.branch);
    } else if (ev.type === 'tool.execution_complete') {
      const r = rec(d.result);
      resultById.set(str(d.toolCallId), { content: str(r.content), isError: d.success === false });
    } else if (ev.type === 'permission.completed') {
      // A denied permission yields no tool.execution_complete; surface the denial
      // as the tool's result so the (passthrough) tool_use isn't left dangling.
      const r = rec(d.result);
      const id = str(d.toolCallId);
      if (str(r.kind).startsWith('denied') && !resultById.has(id)) {
        resultById.set(id, { content: 'Permission denied by the user.', isError: true });
      }
    }
  }
  if (!cwd && ws.cwd) cwd = ws.cwd;
  if (!branch && ws.branch) branch = ws.branch;
  const title = ws.name ?? '';
  const resolveImages = opts.resolveImages ?? false;

  // Pass 2: build the threaded events with a synthesized uuid/parent chain.
  const events: (UserEvent | AssistantEvent)[] = [];
  let seq = 0;
  let prevUuid: string | null = null;
  const nextUuid = (): string => `${sessionId}-${seq++}`;
  const envelope = (ts: string): Pick<
    UserEvent,
    'sessionId' | 'timestamp' | 'cwd' | 'gitBranch' | 'isSidechain'
  > => ({
    sessionId,
    timestamp: ts,
    cwd,
    ...(branch ? { gitBranch: branch } : {}),
    isSidechain: false,
  });
  let model = '';
  let shutdown: MessageUsage | null = null;

  for (const ev of lines) {
    const d = rec(ev.data);
    const ts = str(ev.timestamp);
    if (ev.type === 'session.model_change') {
      if (str(d.newModel)) model = str(d.newModel);
    } else if (ev.type === 'user.message') {
      const content = userBlocks(d, sessionDir, resolveImages);
      const uuid = nextUuid();
      events.push({ uuid, parentUuid: prevUuid, ...envelope(ts), type: 'user', message: { role: 'user', content } } as UserEvent);
      prevUuid = uuid;
    } else if (ev.type === 'assistant.message') {
      if (str(d.model)) model = str(d.model);
      const blocks: ContentBlock[] = [];
      const reasoning = str(d.reasoningOpaque);
      if (reasoning) blocks.push({ type: 'thinking', thinking: '', signature: reasoning });
      const text = str(d.content);
      if (text) blocks.push({ type: 'text', text });
      const toolResults: ToolResultBlock[] = [];
      const reqs = Array.isArray(d.toolRequests) ? d.toolRequests : [];
      for (const r of reqs) {
        const tr = rec(r);
        const id = str(tr.toolCallId);
        const outcome = resultById.get(id);
        blocks.push(toolUseBlock(str(tr.name), rec(tr.arguments), id, !!outcome && !outcome.isError));
        if (outcome) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: outcome.content,
            ...(outcome.isError ? { is_error: true } : {}),
          });
        }
      }
      if (blocks.length === 0) continue; // empty assistant scaffolding turn — skip
      const uuid = nextUuid();
      events.push({
        uuid,
        parentUuid: prevUuid,
        ...envelope(ts),
        type: 'assistant',
        message: { role: 'assistant', model, content: blocks, usage: zeroUsage() },
      } as AssistantEvent);
      prevUuid = uuid;
      // Tool results ride a following synthetic user turn (assembler pairs by id).
      if (toolResults.length > 0) {
        const ruid = nextUuid();
        events.push({ uuid: ruid, parentUuid: prevUuid, ...envelope(ts), type: 'user', message: { role: 'user', content: toolResults } } as UserEvent);
        prevUuid = ruid;
      }
    } else if (ev.type === 'session.shutdown') {
      shutdown = shutdownUsage(d);
    }
    // session.start (pass 1), system.message, session.info, hook.*, tool.*,
    // permission.*, abort, and any unknown/new type are tolerated and skipped.
  }

  // Tokens exist only at session level → attach to the last assistant turn.
  if (shutdown) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e && e.type === 'assistant') {
        e.message.usage = shutdown;
        break;
      }
    }
  }

  return { sessionId, cwd, branch, title, events };
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
  tool_names: string;
  text_content: string;
  /** Session title (read by auxProjections; ignored by the events projection). */
  title: string;
}

/** Flatten a parsed session into canonical index rows for one file. */
export function toCanonicalRows(session: CopilotSession, filePath: string): CanonicalRow[] {
  return session.events.map((e) => {
    const msg = e.message;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const usage = (msg as { usage?: MessageUsage }).usage;
    const text = content
      .map((b) => (b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : ''))
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
      git_branch: session.branch,
      model: (msg as { model?: string }).model ?? null,
      input_tokens: num(usage?.input_tokens),
      output_tokens: num(usage?.output_tokens),
      cache_read_tokens: num(usage?.cache_read_input_tokens),
      cache_write_tokens: num(usage?.cache_creation_input_tokens),
      service_tier: null,
      is_sidechain: false,
      tool_use_count: content.filter((b) => b.type === 'tool_use').length,
      tool_names: toolNamesCsv(content),
      text_content: text,
      title: session.title,
    };
  });
}
