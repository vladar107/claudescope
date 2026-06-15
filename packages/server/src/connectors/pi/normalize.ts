/**
 * pi session → canonical thread normalizer.
 *
 * A pi session (`<ts>_<uuid>.jsonl`) is a flat, threaded record stream: a
 * `session` line (carrying `cwd` + the session id), `message` records
 * (`role: user | assistant | toolResult`), and `model_change` /
 * `thinking_level_change` records. The conversation lives entirely in the
 * `message` records; the model and usage ride the assistant message itself, and
 * `cwd` ride the single `session` line.
 *
 * This parses one session into Claude-shaped `RawEvent[]` — assistant/user turns
 * whose `message.content` carries text / thinking / tool_use / tool_result blocks
 * — so the existing thread assembler and the canonical index row builder both
 * reuse it (mirrors `codex/normalize.ts`).
 *
 * Grouping: each assistant/user `message` record becomes one turn; consecutive
 * `toolResult` records coalesce into a single user turn carrying all their
 * `tool_result` blocks (the Claude convention the thread assembler expects).
 * The `uuid`/`parentUuid` chain is synthesized in file order — pi's native
 * `parentId` graph threads *through* `model_change`/`thinking_level_change`
 * records, so copying it verbatim would dangle.
 *
 * STRICTLY READ-ONLY with respect to ~/.pi — files are only ever read.
 */

import { readFileSync } from 'node:fs';
import type { AssistantEvent, ContentBlock, MessageUsage, UserEvent } from '@claudescope/shared';

export interface PiSession {
  sessionId: string;
  cwd: string;
  events: (UserEvent | AssistantEvent)[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** pi assistant `usage` (`{input, output, cacheRead, cacheWrite, …}`) → canonical usage. */
function toUsage(raw: unknown): MessageUsage {
  const u = (raw ?? {}) as Record<string, unknown>;
  return {
    input_tokens: num(u.input),
    output_tokens: num(u.output),
    cache_read_input_tokens: num(u.cacheRead),
    cache_creation_input_tokens: num(u.cacheWrite),
  };
}

/**
 * Map a pi `toolCall` to a canonical `tool_use` block. pi's tool vocabulary maps
 * 1:1 onto Claude's, so we translate names + input keys to the shapes the web
 * renderer and the Files-changed changeset extractor recognize — both key off the
 * Claude tool names (`Edit`/`MultiEdit`/`Write`/`Read`/`Bash`) and `file_path`,
 * NOT pi's lowercase `edit`/`read`/`bash` with `path`/`oldText`/`newText`. Without
 * this, pi's file edits never reach the Files-changed tab and tools render as raw
 * JSON. Mirrors how the Junie connector emits canonical `Edit` blocks. Unknown
 * tools pass through with their native name (generic rendering).
 */
function toolUseBlock(b: Record<string, unknown>): ContentBlock {
  const id = str(b.id);
  const args = (b.arguments ?? {}) as Record<string, unknown>;
  switch (str(b.name)) {
    case 'edit': {
      // pi edits are `{path, edits:[{oldText,newText}]}` → Claude MultiEdit.
      const edits = (Array.isArray(args.edits) ? args.edits : []).map((e) => {
        const er = (e ?? {}) as Record<string, unknown>;
        return { old_string: str(er.oldText), new_string: str(er.newText) };
      });
      return { type: 'tool_use', id, name: 'MultiEdit', input: { file_path: str(args.path), edits } };
    }
    case 'write':
      return {
        type: 'tool_use',
        id,
        name: 'Write',
        input: { file_path: str(args.path), content: str(args.content) || str(args.text) },
      };
    case 'read':
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
    default:
      return { type: 'tool_use', id, name: str(b.name), input: args };
  }
}

/** Map a pi assistant message's content blocks to canonical content blocks. */
function assistantBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const b = c as Record<string, unknown>;
    switch (str(b.type)) {
      case 'text': {
        const text = str(b.text);
        if (text) out.push({ type: 'text', text });
        break;
      }
      case 'thinking':
        // pi stores PLAINTEXT reasoning (not just a signature, unlike Claude /
        // Codex) — keep it. `thinkingSignature` is an opaque encrypted blob.
        out.push({
          type: 'thinking',
          thinking: str(b.thinking),
          ...(str(b.thinkingSignature) ? { signature: str(b.thinkingSignature) } : {}),
        });
        break;
      case 'image': {
        const img = imageBlock(b);
        if (img) out.push(img);
        break;
      }
      case 'toolCall':
        out.push(toolUseBlock(b));
        break;
      default:
        break; // unknown block type — tolerate and skip
    }
  }
  return out;
}

/** Map a pi `{type:'image', data, mimeType}` block to a canonical ImageBlock. */
function imageBlock(b: Record<string, unknown>): ContentBlock | null {
  const data = str(b.data);
  if (!data) return null; // only inline base64 is embeddable
  return {
    type: 'image',
    source: { type: 'base64', media_type: str(b.mimeType) || 'image/png', data },
  };
}

/**
 * Map a pi user / toolResult message's content to canonical blocks. Keeps text
 * AND images: pi returns a pasted screenshot as `{type:'image', data, mimeType}`
 * inside a `read` tool result (the user message only holds the temp-file path),
 * so dropping non-text blocks here would lose the embedded screenshot.
 */
function contentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const b = c as Record<string, unknown>;
    if (str(b.type) === 'text') {
      if (str(b.text)) out.push({ type: 'text', text: str(b.text) });
    } else if (str(b.type) === 'image') {
      const img = imageBlock(b);
      if (img) out.push(img);
    }
  }
  return out;
}

interface PiLine {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    model?: string;
    usage?: unknown;
    toolCallId?: string;
  };
  id?: string;
  cwd?: string;
}

/** Parse a pi session JSONL into a Claude-shaped session, or null if unreadable. */
export function parsePiSession(path: string): PiSession | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines: PiLine[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      lines.push(JSON.parse(t) as PiLine);
    } catch {
      /* tolerate a corrupt/partial trailing line */
    }
  }

  // The session record carries the immutable session id + cwd for every event.
  const session = lines.find((l) => l.type === 'session');
  const sessionId = str(session?.id) || path;
  const cwd = str(session?.cwd);

  const events: (UserEvent | AssistantEvent)[] = [];
  let seq = 0;
  let prevUuid: string | null = null;
  const nextUuid = (): string => `${sessionId}-${seq++}`;

  // Consecutive `toolResult` records coalesce into one user turn.
  let toolResults: ContentBlock[] = [];
  let toolResultTs = '';
  const flushToolResults = (): void => {
    if (toolResults.length === 0) return;
    const uuid = nextUuid();
    events.push({
      uuid,
      parentUuid: prevUuid,
      sessionId,
      timestamp: toolResultTs,
      cwd,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: toolResults },
    } as UserEvent);
    prevUuid = uuid;
    toolResults = [];
    toolResultTs = '';
  };

  for (const line of lines) {
    if (line.type !== 'message' || !line.message) continue;
    const msg = line.message;
    const role = str(msg.role);
    const ts = str(line.timestamp);

    if (role === 'toolResult') {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: str(msg.toolCallId),
        content: contentBlocks(msg.content),
      });
      if (!toolResultTs) toolResultTs = ts;
      continue;
    }

    // A real user/assistant turn closes any pending tool-result group first.
    flushToolResults();

    if (role === 'assistant') {
      const uuid = nextUuid();
      events.push({
        uuid,
        parentUuid: prevUuid,
        sessionId,
        timestamp: ts,
        cwd,
        isSidechain: false,
        type: 'assistant',
        message: {
          role: 'assistant',
          model: str(msg.model),
          content: assistantBlocks(msg.content),
          usage: toUsage(msg.usage),
        },
      } as AssistantEvent);
      prevUuid = uuid;
    } else if (role === 'user') {
      const uuid = nextUuid();
      events.push({
        uuid,
        parentUuid: prevUuid,
        sessionId,
        timestamp: ts,
        cwd,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: contentBlocks(msg.content) },
      } as UserEvent);
      prevUuid = uuid;
    }
    // other roles (none observed) are tolerated and skipped
  }
  flushToolResults();

  return { sessionId, cwd, events };
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
export function toCanonicalRows(session: PiSession, filePath: string): CanonicalRow[] {
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
      git_branch: null,
      model: (msg as { model?: string }).model ?? null,
      input_tokens: num(usage?.input_tokens),
      output_tokens: num(usage?.output_tokens),
      cache_read_tokens: num(usage?.cache_read_input_tokens),
      cache_write_tokens: num(usage?.cache_creation_input_tokens),
      service_tier: null,
      is_sidechain: false,
      tool_use_count: content.filter((b) => b.type === 'tool_use').length,
      text_content: text,
    };
  });
}
