/**
 * opencode session → canonical thread normalizer.
 *
 * opencode stores a session across `message` + `part` rows (see `db.ts`). This
 * turns one session into Claude-shaped `RawEvent[]` (so the thread assembler and
 * the canonical index rows reuse it), mirroring the Codex/pi normalizers.
 *
 * Key opencode specifics:
 *  - **File edits go through `apply_patch`**, not edit/write. We translate each
 *    `apply_patch` part into canonical `Write`/`Edit`/`MultiEdit` tool_use blocks
 *    (one per touched file) so the Files-changed tab (`changeset.ts`) and tool
 *    rendering work — preferring `state.metadata.files[]` (a typed per-file unified
 *    diff, present on every COMPLETED patch) over the raw V4A `patchText`.
 *  - **Reasoning is PLAINTEXT** (`reasoning` part → thinking block).
 *  - **Screenshots** ride a `file` part (`{mime, url:data-URL}`) on the user
 *    message → canonical base64/url `ImageBlock`.
 *  - Tokens are per-message (`message.data.tokens`); reasoning folds into output.
 *  - A tool part carries BOTH the call and its result, so we emit the `tool_use`
 *    on the assistant turn and the `tool_result` on a following synthetic user
 *    turn (the Claude/Codex/pi convention the assembler pairs by id).
 *  - **Task-spawned children** (`session.parent_id`) key their rows to the ROOT
 *    ancestor with `is_sidechain: true`, and the spawning `task` part becomes a
 *    canonical `Task` block — so the child nests under its parent session
 *    (the antigravity pattern).
 */

import type {
  AssistantEvent,
  ContentBlock,
  MessageUsage,
  ToolResultBlock,
  ToolUseBlock,
  UserEvent,
} from '@claudescope/shared';
import type { OpencodeRawSession } from './db.js';
import { toolNamesCsv } from '../tool-names.js';
import { toolErrorCount } from '../tool-errors.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function parseJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isoFromMs(ms: unknown): string {
  const n = num(ms);
  return n > 0 ? new Date(n).toISOString() : '';
}

// --- apply_patch → canonical edit blocks ------------------------------------

interface Hunk {
  oldText: string;
  newText: string;
}

/**
 * Parse a unified diff (`metadata.files[].patch`: `Index:`/`---`/`+++`/`@@ … @@`)
 * into hunks. Header lines before the first `@@` are skipped; within a hunk,
 * ` ` = context (both sides), `-` = removed (old side), `+` = added (new side).
 * Exactly one prefix char is stripped (leading whitespace in code is preserved).
 */
function parseHunks(patch: string): Hunk[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const hunks: Hunk[] = [];
  let cur: { old: string[]; neu: string[] } | null = null;
  const flush = (): void => {
    if (cur) hunks.push({ oldText: cur.old.join('\n'), newText: cur.neu.join('\n') });
  };
  for (const line of lines) {
    if (line.startsWith('@@')) {
      flush();
      cur = { old: [], neu: [] };
      continue;
    }
    if (!cur) continue; // still in the diff header
    const tag = line[0];
    const body = line.slice(1);
    if (tag === ' ') {
      cur.old.push(body);
      cur.neu.push(body);
    } else if (tag === '-') {
      cur.old.push(body);
    } else if (tag === '+') {
      cur.neu.push(body);
    }
    // '\' (no-newline marker) and stray lines: ignored
  }
  flush();
  return hunks;
}

/**
 * opencode's `read` tool wraps its output as
 * `<path>…</path>\n<type>file</type>\n<content>\n1: …\n</content>\n(End of file …)`.
 * The canonical `Read` block already shows the path (from `file_path`), so unwrap
 * to just the `<content>` body (line numbers kept) and drop the redundant tags.
 */
function unwrapReadOutput(output: string): string {
  const m = output.match(/<content>\n?([\s\S]*?)\n?<\/content>/);
  return m?.[1] ?? output;
}

/** A concise per-file status for an apply_patch result (avoids repeating the
 *  whole multi-file "Success. Updated …" summary on every fanned-out block). */
function fileStatus(file: Record<string, unknown>): string {
  const type = str(file.type);
  const verb = type === 'add' ? 'Created' : type === 'delete' ? 'Deleted' : 'Updated';
  return `${verb} ${str(file.relativePath) || str(file.filePath)}`;
}

/** One `metadata.files[]` entry → a canonical Write/Edit/MultiEdit tool_use block. */
function fileToToolUse(file: Record<string, unknown>, id: string): ToolUseBlock {
  const file_path = str(file.filePath) || str(file.relativePath);
  const hunks = parseHunks(str(file.patch));
  const type = str(file.type);
  if (type === 'add') {
    const content = hunks
      .map((h) => h.newText)
      .filter((t) => t.length > 0)
      .join('\n');
    return { type: 'tool_use', id, name: 'Write', input: { file_path, content } };
  }
  if (type === 'delete') {
    const old = hunks
      .map((h) => h.oldText)
      .filter((t) => t.length > 0)
      .join('\n');
    return { type: 'tool_use', id, name: 'Edit', input: { file_path, old_string: old, new_string: '' } };
  }
  // update
  const edits = hunks.map((h) => ({ old_string: h.oldText, new_string: h.newText }));
  return { type: 'tool_use', id, name: 'MultiEdit', input: { file_path, edits } };
}

interface ToolBlocks {
  uses: ContentBlock[];
  results: ToolResultBlock[];
}

/**
 * Map one `tool` part to canonical tool_use block(s) + their tool_result(s),
 * paired by `callID`. `apply_patch` fans out to one block PER touched file (so
 * each file is its own diff in the thread and in the Files-changed tab).
 */
function toolPartBlocks(data: Record<string, unknown>): ToolBlocks {
  const tool = str(data.tool);
  const callID = str(data.callID);
  const state = (data.state ?? {}) as Record<string, unknown>;
  const input = (state.input ?? {}) as Record<string, unknown>;
  const output = str(state.output);
  const isError = str(state.status) === 'error' || state.error != null;
  const result = (id: string, content: string): ToolResultBlock => ({
    type: 'tool_result',
    tool_use_id: id,
    content,
    ...(isError ? { is_error: true } : {}),
  });

  if (tool === 'apply_patch') {
    const metadata = (state.metadata ?? {}) as Record<string, unknown>;
    const files = Array.isArray(metadata.files) ? (metadata.files as Record<string, unknown>[]) : [];
    if (files.length > 0) {
      const uses: ContentBlock[] = [];
      const results: ToolResultBlock[] = [];
      files.forEach((f, i) => {
        const id = files.length === 1 ? callID : `${callID}#${i}`;
        uses.push(fileToToolUse(f, id));
        // Per-file status, NOT the shared multi-file summary (which would repeat
        // identically on every fanned-out block).
        results.push(result(id, fileStatus(f)));
      });
      return { uses, results };
    }
    // No metadata (the error/rejected case) — show the attempted patch + error.
    return {
      uses: [{ type: 'tool_use', id: callID, name: 'apply_patch', input }],
      results: [result(callID, output || str(state.error) || 'patch failed')],
    };
  }

  let use: ToolUseBlock;
  if (tool === 'read') {
    use = {
      type: 'tool_use',
      id: callID,
      name: 'Read',
      input: { file_path: str(input.filePath), offset: input.offset, limit: input.limit },
    };
  } else if (tool === 'bash') {
    use = {
      type: 'tool_use',
      id: callID,
      name: 'Bash',
      input: { command: str(input.command), timeout: input.timeout, description: str(input.description) },
    };
  } else if (tool === 'task') {
    // task (subagent spawn) → canonical `Task`, so the re-parented child session
    // nests at this call (`buildSubagentRuns` anchors by matching description).
    use = {
      type: 'tool_use',
      id: callID,
      name: 'Task',
      input: {
        description: str(input.description),
        subagent_type: str(input.subagent_type),
        prompt: str(input.prompt),
      },
    };
  } else {
    // grep / glob / webfetch / skill / todowrite / unknown → generic passthrough
    use = { type: 'tool_use', id: callID, name: tool, input };
  }
  // `read` output is wrapped in <path>/<type>/<content> — unwrap it; others raw.
  return { uses: [use], results: [result(callID, tool === 'read' ? unwrapReadOutput(output) : output)] };
}

// --- content blocks ---------------------------------------------------------

/** A `file` part → canonical ImageBlock when it's an image; else null. */
function imageBlock(data: Record<string, unknown>): ContentBlock | null {
  const url = str(data.url);
  if (!str(data.mime).startsWith('image/') || !url) return null;
  // opencode stores a `data:<mime>;base64,…` URL — renders as a `url` source.
  return { type: 'image', source: { type: 'url', url } };
}

/** message.data.tokens → canonical usage (reasoning folded into output). */
function toUsage(tokens: unknown): MessageUsage {
  const t = (tokens ?? {}) as Record<string, unknown>;
  const cache = (t.cache ?? {}) as Record<string, unknown>;
  return {
    input_tokens: num(t.input),
    output_tokens: num(t.output) + num(t.reasoning),
    cache_read_input_tokens: num(cache.read),
    cache_creation_input_tokens: num(cache.write),
  };
}

// --- session → events -------------------------------------------------------

export function buildEvents(session: OpencodeRawSession): (UserEvent | AssistantEvent)[] {
  const events: (UserEvent | AssistantEvent)[] = [];
  const cwd = session.directory;
  // A task-spawned child keys to its root ancestor and flags sidechain, so it
  // folds into the parent session (claude-code/antigravity convention). Uuids
  // stay namespaced by the child's own id — no collision with parent rows.
  const sessionId = session.rootId;
  const isSidechain = session.rootId !== session.id;
  let seq = 0;
  let prevUuid: string | null = null;
  const nextUuid = (): string => `${session.id}-${seq++}`;

  for (const m of session.messages) {
    const data = parseJson(m.data);
    const role = str(data.role);
    const ts = isoFromMs((data.time as Record<string, unknown> | undefined)?.created);
    const parts = (session.partsByMessage.get(m.id) ?? []).map(parseJson);

    if (role === 'assistant') {
      const blocks: ContentBlock[] = [];
      const toolResults: ToolResultBlock[] = [];
      for (const p of parts) {
        switch (str(p.type)) {
          case 'text':
            if (str(p.text)) blocks.push({ type: 'text', text: str(p.text) });
            break;
          case 'reasoning':
            // plaintext reasoning — keep it (no empty-thinking gotcha for opencode)
            blocks.push({ type: 'thinking', thinking: str(p.text) });
            break;
          case 'file': {
            const img = imageBlock(p);
            if (img) blocks.push(img);
            break;
          }
          case 'tool': {
            const { uses, results } = toolPartBlocks(p);
            blocks.push(...uses);
            toolResults.push(...results);
            break;
          }
          default:
            break; // step-start / step-finish / patch → dropped
        }
      }
      const model =
        str(data.modelID) || str((data.model as Record<string, unknown> | undefined)?.modelID);
      const provider =
        str(data.providerID) || str((data.model as Record<string, unknown> | undefined)?.providerID);
      const uuid = nextUuid();
      const parentUuid = prevUuid;
      prevUuid = uuid;
      events.push({
        uuid,
        parentUuid,
        sessionId,
        timestamp: ts,
        cwd,
        isSidechain,
        type: 'assistant',
        message: { role: 'assistant', model, provider: provider || undefined, content: blocks, usage: toUsage(data.tokens) },
      } as AssistantEvent);
      // Tool results ride a following synthetic user turn (assembler pairs by id).
      if (toolResults.length > 0) {
        const ruid = nextUuid();
        const rparent = prevUuid;
        prevUuid = ruid;
        events.push({
          uuid: ruid,
          parentUuid: rparent,
          sessionId: session.id,
          timestamp: ts,
          cwd,
          isSidechain: false,
          type: 'user',
          message: { role: 'user', content: toolResults },
        } as UserEvent);
      }
    } else {
      // user (or any non-assistant role) — text + pasted-image file parts
      const blocks: ContentBlock[] = [];
      for (const p of parts) {
        if (str(p.type) === 'text') {
          if (str(p.text)) blocks.push({ type: 'text', text: str(p.text) });
        } else if (str(p.type) === 'file') {
          const img = imageBlock(p);
          if (img) blocks.push(img);
        }
      }
      const uuid = nextUuid();
      const parentUuid = prevUuid;
      prevUuid = uuid;
      events.push({
        uuid,
        parentUuid,
        sessionId,
        timestamp: ts,
        cwd,
        isSidechain,
        type: 'user',
        message: { role: 'user', content: blocks },
      } as UserEvent);
    }
  }

  return events;
}

/**
 * Child-session spawn metadata from a session's `task` parts:
 * `state.metadata.sessionId` (the spawned child) → the Task block's
 * `{subagent_type, description}`. `loadSession` uses it to label each
 * re-parented child with the SAME description as its Task block, which is what
 * `buildSubagentRuns` matches to anchor the run at the spawn point.
 */
export function taskSpawns(
  session: OpencodeRawSession,
): Map<string, { agentType: string; description: string }> {
  const map = new Map<string, { agentType: string; description: string }>();
  for (const m of session.messages) {
    for (const raw of session.partsByMessage.get(m.id) ?? []) {
      const p = parseJson(raw);
      if (str(p.type) !== 'tool' || str(p.tool) !== 'task') continue;
      const state = (p.state ?? {}) as Record<string, unknown>;
      const input = (state.input ?? {}) as Record<string, unknown>;
      const metadata = (state.metadata ?? {}) as Record<string, unknown>;
      const childId = str(metadata.sessionId);
      if (childId) {
        map.set(childId, {
          agentType: str(input.subagent_type),
          description: str(input.description),
        });
      }
    }
  }
  return map;
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
  provider: string | null;
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

/** Flatten a parsed session into canonical index rows for one file. */
export function toCanonicalRows(session: OpencodeRawSession, filePath: string): CanonicalRow[] {
  const isSidechain = session.rootId !== session.id;
  return buildEvents(session).map((e) => {
    const msg = e.message;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const usage = (msg as { usage?: MessageUsage }).usage;
    const text = content
      .map((b) => (b.type === 'text' ? b.text : b.type === 'thinking' ? b.thinking : ''))
      .filter(Boolean)
      .join(' ');
    return {
      file_path: filePath,
      session_id: session.rootId,
      uuid: e.uuid,
      parent_uuid: e.parentUuid,
      role: msg.role,
      type: e.type,
      ts: e.timestamp,
      cwd: session.directory,
      git_branch: null,
      model: (msg as { model?: string }).model ?? null,
      provider: (msg as { provider?: string }).provider ?? null,
      input_tokens: num(usage?.input_tokens),
      output_tokens: num(usage?.output_tokens),
      cache_read_tokens: num(usage?.cache_read_input_tokens),
      cache_write_tokens: num(usage?.cache_creation_input_tokens),
      service_tier: null,
      is_sidechain: isSidechain,
      tool_use_count: content.filter((b) => b.type === 'tool_use').length,
      tool_names: toolNamesCsv(content),
      tool_error_count: toolErrorCount(content),
      text_content: text,
      // A child's title must not clobber the parent's via the titles projection
      // (both files now share one session_id) — emit none for sidechain rows.
      title: isSidechain ? '' : session.title,
    };
  });
}
