/**
 * xAI Grok CLI session → canonical thread normalizer.
 *
 * A Grok session is a directory (`~/.grok/sessions/<encoded-cwd>/<uuid>/`)
 * spreading facts across three files:
 *   - `chat_history.jsonl` — the message spine (OpenAI-Responses style rows:
 *     `system` / `user` / `reasoning` / `assistant` / `tool_result`). Carries
 *     content, `model_id`, and tool calls — but NO timestamps and NO usage.
 *   - `updates.jsonl` — an ACP-style event stream. Carries per-event
 *     `agentTimestampMs` and the ONLY token usage (`turn_completed`, one per
 *     user turn). Best-effort overlay: it may be missing or truncated, so the
 *     parse never fails on it — rows then fall back to `summary.json` times
 *     and the turn reports zero usage.
 *   - `summary.json` — session id, plain `cwd`, `generated_title`,
 *     `created_at`/`updated_at`, and `session_kind: "subagent"` for children.
 *
 * Reasoning rows carry PLAINTEXT summaries (`summary[].text`) next to the
 * opaque `encrypted_content` — like pi/Antigravity, Grok thinking renders.
 *
 * Injected context (user_info, agents-md, system-reminder rows) arrives as
 * standalone `user` rows WITHOUT `prompt_index`; only rows with `prompt_index`
 * are real prompts (their text is wrapped in `<user_query>` tags, stripped
 * here). Skipping the rest keeps fake user bubbles out of the thread and
 * per-session boilerplate out of FTS.
 *
 * Subagents: a child run is a SEPARATE sibling session dir; the only linkage
 * lives in the PARENT dir (`subagents/<child-id>/meta.json`). Children are
 * re-keyed to the parent session id with `is_sidechain: true` (pi pattern) and
 * the parent's `spawn_subagent` call becomes a canonical `Task`, so the child
 * transcript anchors at its spawning call in the detail view.
 *
 * STRICTLY READ-ONLY with respect to ~/.grok — files are only ever read.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AssistantEvent, ContentBlock, MessageUsage, UserEvent } from '@claudescope/shared';
import { toolNamesCsv } from '../tool-names.js';
import { skillNamesCsv } from '../skill-names.js';
import type { CanonicalRow } from '../canonical.js';
import { num, rec, str } from '../json.js';

export interface GrokSession {
  /** Indexing key: the parent's session id for a subagent child, else the own id. */
  sessionId: string;
  /** The session dir's own uuid (uuid prefix; `SubagentSource.agentId`). */
  ownId: string;
  /** True for a subagent child transcript (re-keyed to the parent session). */
  isSidechain: boolean;
  cwd: string;
  /** `summary.json.generated_title` — threaded into the titles aux projection. */
  title: string;
  events: (UserEvent | AssistantEvent)[];
}


/** One raw line of `chat_history.jsonl` (fields we read; others ignored). */
interface GrokChatLine {
  type?: string;
  content?: unknown;
  /** Real user prompts only — injected context rows lack it. */
  prompt_index?: unknown;
  /** `reasoning` rows: `[{type:'summary_text', text}]` (plaintext). */
  summary?: unknown;
  /** `assistant` rows: `[{id, name, arguments: <json string>}]`. */
  tool_calls?: unknown;
  model_id?: unknown;
  tool_call_id?: unknown;
}

/** Tolerantly read a JSONL file as objects, or null if unreadable. */
function readJsonl(path: string): Record<string, unknown>[] | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      lines.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* tolerate a corrupt/partial trailing line */
    }
  }
  return lines;
}

/** Parsed `summary.json` facts (all optional — the file may be missing). */
interface GrokSummary {
  id: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

function readSummary(sessionDir: string): GrokSummary {
  let raw: Record<string, unknown> = {};
  try {
    raw = rec(JSON.parse(readFileSync(join(sessionDir, 'summary.json'), 'utf8')));
  } catch {
    /* missing/corrupt summary — fall back to dir-derived facts */
  }
  const info = rec(raw.info);
  return {
    id: str(info.id),
    cwd: str(info.cwd),
    title: str(raw.generated_title) || str(raw.session_summary),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

/**
 * Memo for {@link childParentMap}, keyed on the cwd dir's mtime: every child
 * parse re-resolves its parent, so indexing N children would otherwise re-scan
 * the sibling dirs N times. A spawn creates the child session dir (bumping the
 * cwd dir's mtime) alongside the parent's `subagents/<id>/` entry, so the memo
 * invalidates when new children appear.
 */
const parentMapMemo = new Map<string, { fp: string; map: Map<string, string> }>();

/**
 * Child-session-id → parent-session-dir map for one cwd dir, built purely from
 * `readdir` of each sibling's `subagents/` folder (no JSON parsing).
 */
function childParentMap(cwdDir: string): Map<string, string> {
  let fp = '';
  try {
    const st = statSync(cwdDir);
    fp = `${Math.floor(st.mtimeMs)}`;
    const hit = parentMapMemo.get(cwdDir);
    if (hit && hit.fp === fp) return hit.map;
  } catch {
    return new Map();
  }
  const map = new Map<string, string>();
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = readdirSync(cwdDir, { withFileTypes: true });
  } catch {
    /* cwd dir vanished — empty map */
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parentDir = join(cwdDir, entry.name);
    let children: string[];
    try {
      children = readdirSync(join(parentDir, 'subagents'));
    } catch {
      continue; // no subagents dir — most sessions
    }
    for (const childId of children) {
      if (childId !== entry.name) map.set(childId, parentDir);
    }
  }
  parentMapMemo.set(cwdDir, { fp, map });
  return map;
}

/**
 * The parent session dir for a subagent child transcript, or null for a
 * top-level session. `path` is the child's `chat_history.jsonl`. The linkage
 * lives only in the parent (`subagents/<child-id>/`), so a vanished parent →
 * null and the orphan indexes as its own top-level session.
 */
export function parentSessionDirOf(path: string): string | null {
  const sessionDir = dirname(path);
  const parent = childParentMap(dirname(sessionDir)).get(basename(sessionDir));
  return parent && existsSync(parent) ? parent : null;
}

/** One `subagents/<child-id>/meta.json` — the parent-side spawn record. */
export interface GrokSubagentMeta {
  childId: string;
  agentType: string;
  /** Correlation key — equals the spawning call's `description` argument. */
  description: string;
}

/** Read every subagent meta recorded in a (parent) session dir. */
export function subagentMetas(sessionDir: string): GrokSubagentMeta[] {
  const subDir = join(sessionDir, 'subagents');
  let ids: string[];
  try {
    ids = readdirSync(subDir);
  } catch {
    return [];
  }
  const out: GrokSubagentMeta[] = [];
  for (const id of ids) {
    try {
      const meta = rec(JSON.parse(readFileSync(join(subDir, id, 'meta.json'), 'utf8')));
      out.push({
        childId: str(meta.child_session_id) || id,
        agentType: str(meta.subagent_type),
        description: str(meta.description),
      });
    } catch {
      /* unreadable meta — the child still indexes; it just attaches detached */
    }
  }
  return out;
}

/** Usage already split into canonical fields (see {@link splitUsage}). */
interface TurnOverlay {
  startMs?: number;
  endMs?: number;
  usage?: MessageUsage;
}

/**
 * Grok's `turn_completed.usage` → canonical usage. `cachedReadTokens` is a
 * SUBSET of `inputTokens` (verified: input + output = total), while Claude
 * semantics — which every session/analytics SUM assumes — keep them disjoint,
 * so the cached part is subtracted out of input. `reasoningTokens` are already
 * inside `outputTokens`. Grok reports no cache writes.
 */
export function splitUsage(raw: unknown): MessageUsage {
  const u = rec(raw);
  const cacheRead = num(u.cachedReadTokens);
  return {
    input_tokens: Math.max(0, num(u.inputTokens) - cacheRead),
    output_tokens: num(u.outputTokens),
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: 0,
  };
}

/** Timing/usage overlay extracted from `updates.jsonl` (best-effort). */
interface UpdatesOverlay {
  /** First `tool_call` update timestamp per toolCallId. */
  toolCallTs: Map<string, number>;
  /** Indexed by user turn (prompt_index order == turn_completed order). */
  turns: TurnOverlay[];
}

/**
 * Parse `updates.jsonl` into the overlay. Turn correlation is positional: the
 * k-th `turn_completed` closes user turn k, and a `user_message_chunk` opens
 * turn k either via its `promptIndex` meta or (when absent) in arrival order.
 * A missing/corrupt file yields an empty overlay — never an error.
 */
function parseUpdates(path: string): UpdatesOverlay {
  const overlay: UpdatesOverlay = { toolCallTs: new Map(), turns: [] };
  const lines = readJsonl(path);
  if (!lines) return overlay;

  const turn = (i: number): TurnOverlay => (overlay.turns[i] ??= {});
  let userChunks = 0;
  let completed = 0;
  let prevWasUserChunk = false;

  for (const line of lines) {
    const params = rec(line.params);
    const update = rec(params.update);
    const kind = str(update.sessionUpdate);
    const ms = num(rec(params._meta).agentTimestampMs) || num(line.timestamp) * 1000;
    if (kind !== 'user_message_chunk') prevWasUserChunk = false;

    switch (kind) {
      case 'user_message_chunk': {
        // Chunks of one message arrive back-to-back; count groups, not chunks.
        const metaIdx = rec(update._meta).promptIndex;
        const idx = typeof metaIdx === 'number' ? metaIdx : prevWasUserChunk ? userChunks - 1 : userChunks;
        if (!prevWasUserChunk) userChunks = idx + 1;
        prevWasUserChunk = true;
        if (ms) turn(idx).startMs ??= ms;
        break;
      }
      case 'tool_call': {
        const id = str(update.toolCallId);
        if (id && ms && !overlay.toolCallTs.has(id)) overlay.toolCallTs.set(id, ms);
        break;
      }
      case 'turn_completed': {
        const t = turn(completed++);
        if (ms) t.endMs = ms;
        t.usage = splitUsage(update.usage);
        break;
      }
      default:
        break;
    }
  }
  return overlay;
}

/**
 * Strip Grok's prompt scaffolding so titles/search/copy show what the user
 * typed: drop `<image_files>` blocks (paste-an-image injects one with
 * saved-to-workspace paths — the image itself rides the sibling image part,
 * so the scaffold is pure noise), then unwrap the `<user_query>` tag when it
 * wraps the whole remainder. The inline `[Image #N]` marker stays (copilot
 * precedent).
 */
export function stripUserQuery(text: string): string {
  const cleaned = text.replace(/<image_files>[\s\S]*?<\/image_files>\s*/g, '');
  const m = /^\s*<user_query>\n?([\s\S]*?)\n?<\/user_query>\s*$/.exec(cleaned);
  return m?.[1] ?? cleaned;
}

/** Map a Grok `{type:'image', url:'data:…'}` part to a canonical ImageBlock. */
function imageBlock(part: Record<string, unknown>): ContentBlock | null {
  const m = /^data:([^;,]+);base64,(.+)$/.exec(str(part.url));
  if (!m?.[1] || !m[2]) return null; // only inline base64 data-URLs are embeddable
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

/** Map a user row's content parts to canonical blocks (text + inline images). */
function userBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    const text = stripUserQuery(content);
    return text ? [{ type: 'text', text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const c of content) {
    const part = rec(c);
    if (str(part.type) === 'text') {
      const text = stripUserQuery(str(part.text));
      if (text) out.push({ type: 'text', text });
    } else if (str(part.type) === 'image') {
      const img = imageBlock(part);
      if (img) out.push(img);
    }
  }
  return out;
}

/**
 * Map a Grok tool call to a canonical `tool_use` block. Grok's built-in tools
 * map 1:1 onto Claude's (the binary itself aliases `Read`→`read_file`,
 * `Edit`→`search_replace`, …), so we translate names + input keys to the
 * shapes the web renderer and the Files-changed changeset extractor recognize.
 * Arg shapes verified against a real session: `write {file_path, content}`,
 * `search_replace {file_path, old_string, new_string}`, `read_file
 * {target_file}`, `list_dir {target_directory}`. Unknown tools (incl. MCP's
 * `server__tool`) pass through with their native name.
 */
function toolUseBlock(
  raw: Record<string, unknown>,
  agentTypeByDescription: Map<string, string>,
): ContentBlock {
  const id = str(raw.id);
  const name = str(raw.name);
  let args: Record<string, unknown>;
  try {
    args = rec(JSON.parse(str(raw.arguments) || '{}'));
  } catch {
    // Unparseable arguments — keep the raw string visible under the native name.
    return { type: 'tool_use', id, name, input: { arguments: str(raw.arguments) } };
  }
  switch (name) {
    case 'read_file':
    case 'hashline_read':
      return {
        type: 'tool_use',
        id,
        name: 'Read',
        input: {
          file_path: str(args.target_file) || str(args.file_path),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
      };
    case 'write':
      return {
        type: 'tool_use',
        id,
        name: 'Write',
        input: { file_path: str(args.file_path), content: str(args.content) },
      };
    case 'search_replace':
    case 'hashline_edit':
      return {
        type: 'tool_use',
        id,
        name: 'Edit',
        input: {
          file_path: str(args.file_path) || str(args.target_file),
          old_string: str(args.old_string),
          new_string: str(args.new_string),
          ...(args.replace_all !== undefined ? { replace_all: args.replace_all } : {}),
        },
      };
    case 'run_terminal_command':
      return {
        type: 'tool_use',
        id,
        name: 'Bash',
        input: {
          command: str(args.command),
          description: str(args.description),
          ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
        },
      };
    case 'grep':
      return { type: 'tool_use', id, name: 'Grep', input: args };
    case 'list_dir':
      return {
        type: 'tool_use',
        id,
        name: 'LS',
        input: { path: str(args.target_directory) || str(args.path) },
      };
    case 'web_search':
      return { type: 'tool_use', id, name: 'WebSearch', input: args };
    case 'web_fetch':
      return { type: 'tool_use', id, name: 'WebFetch', input: args };
    case 'todo_write':
      return { type: 'tool_use', id, name: 'TodoWrite', input: args };
    case 'skill':
      return { type: 'tool_use', id, name: 'Skill', input: args };
    case 'spawn_subagent': {
      // Spawns a sibling child session → canonical `Task` so the embedded
      // transcript anchors here. `subagent_type` isn't in the call args — it
      // comes from the parent's own `subagents/<id>/meta.json`, matched by the
      // shared `description` (both derive from this call's argument).
      const description = str(args.description);
      return {
        type: 'tool_use',
        id,
        name: 'Task',
        input: {
          description,
          subagent_type: agentTypeByDescription.get(description) ?? '',
          prompt: str(args.prompt),
        },
      };
    }
    default:
      return { type: 'tool_use', id, name, input: args };
  }
}

/** Parse a Grok session dir (via its `chat_history.jsonl` path), or null. */
export function parseGrokSession(path: string): GrokSession | null {
  const chat = readJsonl(path);
  if (!chat) return null;
  const sessionDir = dirname(path);
  const summary = readSummary(sessionDir);
  const ownId = basename(sessionDir) || summary.id || path;

  // A subagent child indexes under its PARENT's session id (with is_sidechain),
  // folding it into the parent session; the own id still prefixes the
  // synthesized uuids to keep them unique across the merged files.
  const parentDir = parentSessionDirOf(path);
  const sessionId = parentDir ? basename(parentDir) : ownId;
  const isSidechain = parentDir !== null;

  const overlay = parseUpdates(join(sessionDir, 'updates.jsonl'));
  const agentTypeByDescription = new Map<string, string>();
  for (const meta of subagentMetas(sessionDir)) {
    if (meta.description) agentTypeByDescription.set(meta.description, meta.agentType);
  }

  const cwd = summary.cwd;
  const events: (UserEvent | AssistantEvent)[] = [];
  let seq = 0;
  let prevUuid: string | null = null;
  const nextUuid = (): string => `${ownId}-${seq++}`;

  // Monotonic carry-forward clock: rows anchor to overlay timestamps where a
  // correlation exists and inherit the previous row's time otherwise, clamped
  // so the sequence never runs backwards. Seeded from summary.created_at.
  let clockMs = Date.parse(summary.createdAt) || 0;
  const tick = (anchorMs?: number): string => {
    if (anchorMs && anchorMs > clockMs) clockMs = anchorMs;
    return clockMs ? new Date(clockMs).toISOString() : '';
  };

  // Reasoning rows precede their assistant row — buffer and prepend.
  let thinking: ContentBlock[] = [];
  // Track the last assistant event of each user turn for usage attachment.
  let currentTurn = -1;
  const lastAssistantIdxByTurn = new Map<number, number>();

  // Consecutive `tool_result` rows coalesce into one user turn.
  let toolResults: ContentBlock[] = [];
  const flushToolResults = (): void => {
    if (toolResults.length === 0) return;
    const uuid = nextUuid();
    events.push({
      uuid,
      parentUuid: prevUuid,
      sessionId,
      timestamp: tick(),
      cwd,
      isSidechain,
      type: 'user',
      message: { role: 'user', content: toolResults },
    } as UserEvent);
    prevUuid = uuid;
    toolResults = [];
  };

  const pushAssistant = (content: ContentBlock[], model: string): void => {
    const uuid = nextUuid();
    // Anchor to the earliest known tool_call time of this row, else — for a
    // final no-tools response — to the turn's completion time.
    const callTimes = content
      .map((b) => (b.type === 'tool_use' ? overlay.toolCallTs.get(b.id) : undefined))
      .filter((t): t is number => typeof t === 'number');
    const hasTools = content.some((b) => b.type === 'tool_use');
    const anchor = callTimes.length
      ? Math.min(...callTimes)
      : !hasTools
        ? overlay.turns[currentTurn]?.endMs
        : undefined;
    events.push({
      uuid,
      parentUuid: prevUuid,
      sessionId,
      timestamp: tick(anchor),
      cwd,
      isSidechain,
      type: 'assistant',
      message: { role: 'assistant', model, content },
    } as AssistantEvent);
    prevUuid = uuid;
    lastAssistantIdxByTurn.set(currentTurn, events.length - 1);
  };

  let lastModel = '';
  for (const raw of chat as GrokChatLine[]) {
    switch (str(raw.type)) {
      case 'user': {
        if (typeof raw.prompt_index !== 'number') break; // injected context row
        flushToolResults();
        currentTurn = raw.prompt_index as number;
        const uuid = nextUuid();
        events.push({
          uuid,
          parentUuid: prevUuid,
          sessionId,
          timestamp: tick(overlay.turns[currentTurn]?.startMs),
          cwd,
          isSidechain,
          type: 'user',
          message: { role: 'user', content: userBlocks(raw.content) },
        } as UserEvent);
        prevUuid = uuid;
        break;
      }
      case 'reasoning': {
        const parts = Array.isArray(raw.summary) ? raw.summary : [];
        for (const p of parts) {
          const text = str(rec(p).text);
          if (text) thinking.push({ type: 'thinking', thinking: text });
        }
        break;
      }
      case 'assistant': {
        flushToolResults();
        const content: ContentBlock[] = [...thinking];
        thinking = [];
        const text = str(raw.content);
        if (text) content.push({ type: 'text', text });
        const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
        for (const c of calls) content.push(toolUseBlock(rec(c), agentTypeByDescription));
        lastModel = str(raw.model_id) || lastModel;
        pushAssistant(content, str(raw.model_id));
        break;
      }
      case 'tool_result': {
        const text = str(raw.content);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: str(raw.tool_call_id),
          content: text ? [{ type: 'text', text }] : [],
        });
        break;
      }
      default:
        break; // system / unknown rows — tolerate and skip
    }
  }
  flushToolResults();
  // A trailing reasoning row with no assistant after it (truncated session).
  if (thinking.length > 0) pushAssistant(thinking, lastModel);

  // Advance the final row to updated_at when the overlay gave us nothing newer
  // (degenerate-but-honest session duration for a missing updates.jsonl).
  const last = events[events.length - 1];
  const updatedMs = Date.parse(summary.updatedAt) || 0;
  if (last && updatedMs > clockMs) last.timestamp = new Date(updatedMs).toISOString();

  // Attach each turn's usage to that turn's last assistant row, exactly once.
  for (const [turnIdx, eventIdx] of lastAssistantIdxByTurn) {
    const usage = overlay.turns[turnIdx]?.usage;
    if (usage) (events[eventIdx] as AssistantEvent).message.usage = usage;
  }

  return { sessionId, ownId, isSidechain, cwd, title: summary.title, events };
}


/** Flatten a parsed session into canonical index rows for one file. */
export function toCanonicalRows(session: GrokSession, filePath: string): CanonicalRow[] {
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
      model: (msg as { model?: string }).model || null,
      input_tokens: num(usage?.input_tokens),
      output_tokens: num(usage?.output_tokens),
      cache_read_tokens: num(usage?.cache_read_input_tokens),
      cache_write_tokens: num(usage?.cache_creation_input_tokens),
      service_tier: null,
      is_sidechain: session.isSidechain,
      tool_use_count: content.filter((b) => b.type === 'tool_use').length,
      tool_names: toolNamesCsv(content),
      tool_error_count: null,
      tool_error_text: null,
      skill_names: skillNamesCsv(content),
      text_content: text,
      // A sidechain file's rows carry the PARENT's session_id — emitting the
      // child's own title there would overwrite the parent's in the titles
      // aux projection (last(title) per session).
      title: session.isSidechain ? '' : session.title,
    };
  });
}
