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
 *  - **Subagents are inline**: a `task` tool call spawns a subagent whose whole
 *    event stream runs INLINE in the parent's `events.jsonl` between
 *    `subagent.started`/`subagent.completed`, every inner event tagged with an
 *    event-level `agentId` (= the spawning `task` toolCallId). Tagged events are
 *    routed into per-agent buffers (never the main thread), the `task` call is
 *    canonicalized to a `Task` block, and each buffer becomes a `SubagentSource`
 *    nested at its spawn point (matched by description, see `buildSubagentRuns`).
 *
 * STRICTLY READ-ONLY with respect to ~/.copilot — files are only ever read.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  AssistantEvent,
  ContentBlock,
  MessageUsage,
  ToolResultBlock,
  UserEvent,
} from '@claudescope/shared';
import { resolveImageWithin } from '../safe-image.js';
import { toolNamesCsv } from '../tool-names.js';
import { toolErrorCount } from '../tool-errors.js';

/** One inline subagent run, segmented out of the parent's event stream. */
export interface CopilotSubagent {
  /** The spawning `task` toolCallId — the `agentId` tag on the run's events. */
  agentId: string;
  /** Copilot agent name from `subagent.started` (e.g. `explore`); '' if lost. */
  agentType: string;
  /** The `task` call's `arguments.description` — same string the canonical
   *  `Task` block carries, so the run anchors to its spawn point. */
  description: string;
  events: (UserEvent | AssistantEvent)[];
}

export interface CopilotSession {
  sessionId: string;
  cwd: string;
  branch: string | null;
  title: string;
  events: (UserEvent | AssistantEvent)[];
  subagents: CopilotSubagent[];
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

/**
 * Resolve a persisted attachment (`files/<displayName>`) to a base64 `ImageBlock`.
 * The `events.jsonl` attachment `path` is a deleted `$TMPDIR` copy, so we resolve by
 * `displayName` (basename, then symlink-safe containment inside `files/` via the
 * shared resolver). Returns null for a non-image, or when the bytes weren't saved
 * (screenshot-saving off) — the inline `[📷 …]` marker in the message text already
 * conveys the attachment in that case.
 */
function resolveImage(sessionDir: string, displayName: string): ContentBlock | null {
  const name = basename(displayName);
  if (!name) return null;
  const filesDir = join(sessionDir, 'files');
  return resolveImageWithin(filesDir, join(filesDir, name));
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
  /** Present on every event belonging to an inline subagent run (= the
   *  spawning `task` toolCallId); absent on main-thread events. */
  agentId?: string;
}

/** Per-thread turn buffer: the main transcript and each subagent run get their
 *  own event list, uuid chain, and running model. */
interface TurnStream {
  events: (UserEvent | AssistantEvent)[];
  seq: number;
  prevUuid: string | null;
  uuidPrefix: string;
  sidechain: boolean;
  model: string;
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

  // Pass 1: session identity (session.start) + per-tool outcome (success/denied)
  // + subagent identities. Outcomes and subagent metadata are needed when
  // emitting a tool_use, which precedes both the tool.execution_complete and the
  // subagent.started in the stream — so collect them up front.
  const resultById = new Map<string, { content: string; isError: boolean }>();
  const agentMetaById = new Map<string, { agentType: string; model: string }>();
  const knownAgentIds = new Set<string>();
  // `task` toolRequest descriptions by toolCallId — the Task block and its
  // SubagentSource must carry the SAME string (the anchor buildSubagentRuns
  // matches on), so both sides read from this one map.
  const taskDescById = new Map<string, string>();
  for (const ev of lines) {
    const d = rec(ev.data);
    if (str(ev.agentId)) knownAgentIds.add(str(ev.agentId));
    if (ev.type === 'assistant.message') {
      const reqs = Array.isArray(d.toolRequests) ? d.toolRequests : [];
      for (const r of reqs) {
        const tr = rec(r);
        if (str(tr.name) === 'task' && str(tr.toolCallId)) {
          taskDescById.set(str(tr.toolCallId), str(rec(tr.arguments).description));
        }
      }
    } else if (ev.type === 'session.start') {
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
    } else if (ev.type === 'subagent.started') {
      const id = str(d.toolCallId) || str(ev.agentId);
      if (id) {
        knownAgentIds.add(id);
        agentMetaById.set(id, { agentType: str(d.agentName), model: str(d.model) });
      }
    }
  }
  if (!cwd && ws.cwd) cwd = ws.cwd;
  if (!branch && ws.branch) branch = ws.branch;
  const title = ws.name ?? '';
  const resolveImages = opts.resolveImages ?? false;

  // Pass 2: build the threaded events with a synthesized uuid/parent chain.
  // Events tagged with an `agentId` belong to an inline subagent run and are
  // routed into that agent's own stream (never the main thread); untagged
  // events build the main transcript.
  const main: TurnStream = {
    events: [],
    seq: 0,
    prevUuid: null,
    uuidPrefix: sessionId,
    sidechain: false,
    model: '',
  };
  const subStreams = new Map<string, TurnStream>(); // insertion-ordered
  const subStream = (agentId: string): TurnStream => {
    let s = subStreams.get(agentId);
    if (!s) {
      s = {
        events: [],
        seq: 0,
        prevUuid: null,
        uuidPrefix: `${sessionId}-${agentId}`,
        sidechain: true,
        model: agentMetaById.get(agentId)?.model ?? '',
      };
      subStreams.set(agentId, s);
    }
    return s;
  };

  const envelope = (ts: string, sidechain: boolean): Pick<
    UserEvent,
    'sessionId' | 'timestamp' | 'cwd' | 'gitBranch' | 'isSidechain'
  > => ({
    sessionId,
    timestamp: ts,
    cwd,
    ...(branch ? { gitBranch: branch } : {}),
    isSidechain: sidechain,
  });

  const pushUser = (s: TurnStream, ts: string, content: ContentBlock[]): void => {
    const uuid = `${s.uuidPrefix}-${s.seq++}`;
    s.events.push({ uuid, parentUuid: s.prevUuid, ...envelope(ts, s.sidechain), type: 'user', message: { role: 'user', content } } as UserEvent);
    s.prevUuid = uuid;
  };

  /** One `assistant.message` → an assistant turn (+ a tool-result user turn). */
  const assistantTurn = (s: TurnStream, d: Record<string, unknown>, ts: string): void => {
    if (str(d.model)) s.model = str(d.model);
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
      const args = rec(tr.arguments);
      const outcome = resultById.get(id);
      // A `task` call that actually ran a subagent → canonical `Task`: the spawn
      // point the nested run anchors to (buildSubagentRuns matches the run by
      // this description + subagent_type). A task with no trace of a run (never
      // started, no tagged events) passes through under its raw name.
      blocks.push(
        str(tr.name) === 'task' && knownAgentIds.has(id)
          ? {
              type: 'tool_use',
              id,
              name: 'Task',
              input: {
                description: str(args.description),
                subagent_type: agentMetaById.get(id)?.agentType ?? '',
                prompt: str(args.prompt),
              },
            }
          : toolUseBlock(str(tr.name), args, id, !!outcome && !outcome.isError),
      );
      if (outcome) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: id,
          content: outcome.content,
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
    }
    if (blocks.length === 0) return; // empty assistant scaffolding turn — skip
    const uuid = `${s.uuidPrefix}-${s.seq++}`;
    s.events.push({
      uuid,
      parentUuid: s.prevUuid,
      ...envelope(ts, s.sidechain),
      type: 'assistant',
      message: { role: 'assistant', model: s.model, content: blocks, usage: zeroUsage() },
    } as AssistantEvent);
    s.prevUuid = uuid;
    // Tool results ride a following synthetic user turn (assembler pairs by id).
    if (toolResults.length > 0) pushUser(s, ts, toolResults);
  };

  let shutdown: MessageUsage | null = null;
  for (const ev of lines) {
    const d = rec(ev.data);
    const ts = str(ev.timestamp);
    if (ev.type === 'subagent.started' || ev.type === 'subagent.completed') continue; // metadata (pass 1)
    const stream = str(ev.agentId) ? subStream(str(ev.agentId)) : main;
    if (ev.type === 'session.model_change') {
      if (str(d.newModel)) stream.model = str(d.newModel);
    } else if (ev.type === 'user.message') {
      pushUser(stream, ts, userBlocks(d, sessionDir, resolveImages));
    } else if (ev.type === 'assistant.message') {
      assistantTurn(stream, d, ts);
    } else if (ev.type === 'session.shutdown') {
      shutdown = shutdownUsage(d);
    }
    // session.start (pass 1), system.message, session.info, hook.*, tool.*,
    // permission.*, abort, and any unknown/new type are tolerated and skipped.
  }

  // Tokens exist only at session level → attach to the last MAIN assistant turn
  // (subagent turns carry no usage; Copilot reports no per-agent breakdown).
  if (shutdown) {
    for (let i = main.events.length - 1; i >= 0; i--) {
      const e = main.events[i];
      if (e && e.type === 'assistant') {
        e.message.usage = shutdown;
        break;
      }
    }
  }

  const subagents: CopilotSubagent[] = [];
  for (const [agentId, s] of subStreams) {
    if (s.events.length === 0) continue; // spawned but produced nothing — no run to show
    subagents.push({
      agentId,
      agentType: agentMetaById.get(agentId)?.agentType ?? '',
      // '' when the spawning call is lost — renders detached, never mismatched.
      description: taskDescById.get(agentId) ?? '',
      events: s.events,
    });
  }

  return { sessionId, cwd, branch, title, events: main.events, subagents };
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
  tool_error_count: number | null;
  text_content: string;
  /** Session title (read by auxProjections; ignored by the events projection). */
  title: string;
}

/** Flatten a parsed session into canonical index rows for one file. Subagent
 *  events are included (same session, `is_sidechain` true) so their text is
 *  searchable under the session and `has_sidechain` flips on. */
export function toCanonicalRows(session: CopilotSession, filePath: string): CanonicalRow[] {
  const all = [...session.events, ...session.subagents.flatMap((s) => s.events)];
  return all.map((e) => {
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
      is_sidechain: e.isSidechain === true,
      tool_use_count: content.filter((b) => b.type === 'tool_use').length,
      tool_names: toolNamesCsv(content),
      tool_error_count: toolErrorCount(content),
      text_content: text,
      title: session.title,
    };
  });
}
