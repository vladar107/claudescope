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
 * Subagents: a `subagent` toolCall (`{agent, task}`) spawns a child run whose
 * transcript nests on disk under the session's sibling dir —
 * `<sessionBase>/<runId>/run-<N>/session.jsonl` (runId from the toolResult's
 * `details`). A child carries its own `session` record with NO parent ref, so
 * parentage is derived purely from that path shape: child rows are re-keyed to
 * the parent's session id with `is_sidechain: true` (antigravity pattern), which
 * folds them into the parent session for lists/search and hands their paths to
 * `loadSession`, where they attach as SubagentSources at their spawning `Task`.
 *
 * STRICTLY READ-ONLY with respect to ~/.pi — files are only ever read.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { AssistantEvent, ContentBlock, MessageUsage, UserEvent } from '@claudescope/shared';
import { toolNamesCsv } from '../tool-names.js';
import { skillNamesCsv } from '../skill-names.js';
import { toolErrorCount, toolErrorText } from '../tool-errors.js';
import type { CanonicalRow } from '../canonical.js';
import { num, rec, str } from '../json.js';

export interface PiSession {
  /** Indexing key: the parent's session id for a nested subagent, else the own id. */
  sessionId: string;
  /** The file's own `session` record id (uuid prefix; `SubagentSource.agentId`). */
  ownId: string;
  /** True for a nested subagent transcript (re-keyed to the parent session). */
  isSidechain: boolean;
  cwd: string;
  events: (UserEvent | AssistantEvent)[];
}


/**
 * First line of a subagent task, truncated — used as the correlation key AND
 * label: the synthesized `Task` block's `input.description` and the
 * `SubagentSource.description` must be derived identically or the thread
 * assembler can't anchor the run (mirrors antigravity's `subagentLabel`).
 */
export function subagentLabel(task: string): string {
  const line = task.trim().split('\n')[0]?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

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
    case 'subagent':
      // pi's agent-dispatch tool: `{agent, task}` spawns a child run → canonical
      // `Task` so the embedded subagent transcript anchors at this call.
      // Management actions (`{action:'list'}` etc.) have no agent/task and stay
      // passthrough — they spawn nothing.
      if (str(args.agent) && str(args.task)) {
        return {
          type: 'tool_use',
          id,
          name: 'Task',
          input: {
            description: subagentLabel(str(args.task)),
            subagent_type: str(args.agent),
            prompt: str(args.task),
          },
        };
      }
      return { type: 'tool_use', id, name: str(b.name), input: args };
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
    provider?: string;
    usage?: unknown;
    toolCallId?: string;
    /** Set on `toolResult` records — the tool the result belongs to. */
    toolName?: string;
    /** `subagent` toolResult metadata: `{mode, runId, results:[{agent, task}]}`. */
    details?: unknown;
  };
  id?: string;
  cwd?: string;
}

/** Tolerantly read a pi JSONL file, or null if unreadable. */
function readLines(path: string): PiLine[] | null {
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
  return lines;
}

/**
 * Memo for {@link sessionIdOf}, keyed on an mtime/size fingerprint: every child
 * parse re-resolves its parent's id, so indexing N children of one session would
 * otherwise re-read the parent file N times (and loadSession again).
 */
const sessionIdMemo = new Map<string, { fp: string; id: string }>();

/** A file's own session id, with the same fallback rule as {@link parsePiSession}. */
function sessionIdOf(path: string): string {
  let fp = '';
  try {
    const st = statSync(path);
    fp = `${Math.floor(st.mtimeMs)}:${st.size}`;
    const hit = sessionIdMemo.get(path);
    if (hit && hit.fp === fp) return hit.id;
  } catch {
    /* stat failed — fall through to the uncached read (and its path fallback) */
  }
  const session = readLines(path)?.find((l) => l.type === 'session');
  const id = str(session?.id) || path;
  if (fp) sessionIdMemo.set(path, { fp, id });
  return id;
}

/**
 * The parent session file for a nested subagent transcript, or null for a
 * top-level session. Children live at `<parentBase>/<runId>/run-<N>/session.jsonl`
 * next to `<parentBase>.jsonl`; the path shape alone is the parent link (a child
 * carries no parent ref). A missing parent file → null, so an orphaned child
 * indexes as its own top-level session instead of keying to a dead id.
 */
export function parentSessionFile(path: string): string | null {
  if (basename(path) !== 'session.jsonl') return null;
  const runDir = dirname(path); // …/<parentBase>/<runId>/run-<N>
  if (!/^run-\d+$/.test(basename(runDir))) return null;
  const parentFile = `${dirname(dirname(runDir))}.jsonl`;
  return existsSync(parentFile) ? parentFile : null;
}

/** Parse a pi session JSONL into a Claude-shaped session, or null if unreadable. */
export function parsePiSession(path: string): PiSession | null {
  const lines = readLines(path);
  if (!lines) return null;

  // The session record carries the immutable session id + cwd for every event.
  const session = lines.find((l) => l.type === 'session');
  const ownId = str(session?.id) || path;
  const cwd = str(session?.cwd);

  // A nested subagent transcript indexes under its PARENT's session id (with
  // is_sidechain), so it folds into the parent session; the own id still
  // prefixes the synthesized uuids to keep them unique across the merged files.
  const parentFile = parentSessionFile(path);
  const sessionId = parentFile ? sessionIdOf(parentFile) : ownId;
  const isSidechain = parentFile !== null;

  const events: (UserEvent | AssistantEvent)[] = [];
  let seq = 0;
  let prevUuid: string | null = null;
  const nextUuid = (): string => `${ownId}-${seq++}`;

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
      isSidechain,
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
        isSidechain,
        type: 'assistant',
        message: {
          role: 'assistant',
          model: str(msg.model),
          provider: str(msg.provider) || undefined,
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
        isSidechain,
        type: 'user',
        message: { role: 'user', content: contentBlocks(msg.content) },
      } as UserEvent);
      prevUuid = uuid;
    }
    // other roles (none observed) are tolerated and skipped
  }
  flushToolResults();

  return { sessionId, ownId, isSidechain, cwd, events };
}

/** One spawned child run recoverable from a session's `subagent` tool records. */
export interface PiSubagentRun {
  /** `details.runId` — names the child dir under `<sessionBase>/`. */
  runId: string;
  /** Index into `details.results` — names the `run-<N>` dir. */
  runIndex: number;
  /** The dispatched agent's name (`results[i].agent`). */
  agentType: string;
  /** Correlation key — same derivation as the `Task` block's `input.description`. */
  description: string;
}

/**
 * Scan a (main) session file for completed `subagent` runs. The description is
 * derived from the spawning toolCall's `args.task` (found via `toolCallId`) —
 * NOT from `results[i].task`, which pi may suffix with an output section — so it
 * equals the synthesized `Task` block's `input.description` and the run anchors.
 * Management calls (no `runId`) are skipped.
 */
export function subagentRuns(path: string): PiSubagentRun[] {
  const lines = readLines(path);
  if (!lines) return [];

  const taskByCallId = new Map<string, string>();
  for (const l of lines) {
    if (l.type !== 'message' || str(l.message?.role) !== 'assistant') continue;
    const content = l.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      const b = rec(c);
      const args = rec(b.arguments);
      if (str(b.type) === 'toolCall' && str(b.name) === 'subagent' && str(args.task)) {
        taskByCallId.set(str(b.id), str(args.task));
      }
    }
  }

  const runs: PiSubagentRun[] = [];
  for (const l of lines) {
    const msg = l.message;
    if (l.type !== 'message' || !msg) continue;
    if (str(msg.role) !== 'toolResult' || str(msg.toolName) !== 'subagent') continue;
    const details = rec(msg.details);
    const runId = str(details.runId);
    if (!runId) continue; // management action — nothing spawned
    const task = taskByCallId.get(str(msg.toolCallId));
    const results = Array.isArray(details.results) ? details.results : [];
    results.forEach((r, i) => {
      const rr = rec(r);
      // Fallback to results[i].task: subagentLabel keeps only the first line, so
      // a suffixed output section can't diverge the key.
      runs.push({
        runId,
        runIndex: i,
        agentType: str(rr.agent),
        description: subagentLabel(task ?? str(rr.task)),
      });
    });
  }
  return runs;
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
      provider: (msg as { provider?: string }).provider ?? null,
      input_tokens: num(usage?.input_tokens),
      output_tokens: num(usage?.output_tokens),
      cache_read_tokens: num(usage?.cache_read_input_tokens),
      cache_write_tokens: num(usage?.cache_creation_input_tokens),
      service_tier: null,
      is_sidechain: session.isSidechain,
      tool_use_count: content.filter((b) => b.type === 'tool_use').length,
      tool_names: toolNamesCsv(content),
      tool_error_count: toolErrorCount(content),
      tool_error_text: toolErrorText(content),
      skill_names: skillNamesCsv(content),
      text_content: text,
    };
  });
}
