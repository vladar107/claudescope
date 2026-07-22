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
 * function_call, custom_tool_call, *_search_call) coalesce into one assistant
 * turn; user-side items (user message, *_call_output) coalesce into one user
 * turn. `developer` messages (the system prompt) are dropped. Tokens from
 * `token_count` are attributed to the most recent assistant turn.
 *
 * Subagents: a `thread_source: "subagent"` rollout is a separate file linked to
 * its parent via `source.subagent.thread_spawn.parent_thread_id`; it is re-keyed
 * to the ROOT thread id (`is_sidechain: true`) so it folds into the parent
 * session, and the parent's `spawn_agent` call becomes a canonical `Task` block
 * the nested run anchors to.
 */

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  AssistantEvent,
  ContentBlock,
  MessageUsage,
  ToolUseBlock,
  UserEvent,
} from '@claudescope/shared';
import { codexSessionsDir } from '../../settings.js';
import { toolNamesCsv } from '../tool-names.js';
import { toolErrorCount } from '../tool-errors.js';

interface CodexLine {
  type?: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}

export interface CodexSession {
  /** Own thread id — the correlation key `loadSession` splits files by. */
  sessionId: string;
  /** Indexing key: the ROOT thread id (the top-level ancestor, for a subagent). */
  indexSessionId: string;
  /** True for a `thread_source: "subagent"` rollout (re-parented under the root). */
  isSidechain: boolean;
  /** `thread_spawn.agent_role` for a subagent rollout (fallback agentType). */
  agentRole?: string;
  cwd: string;
  gitBranch?: string;
  /** `model_provider` from session_meta — session-level, applied to every
   *  assistant row (e.g. 'openai'). */
  modelProvider?: string;
  events: (UserEvent | AssistantEvent)[];
  /** Spawned child thread id → Task correlation meta, from this rollout's
   *  `spawn_agent` calls (description must equal the Task block's). */
  spawnedAgents: Map<string, { description: string; agentType: string }>;
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

/** Coerce to a record, else `{}` (arrays are not records). */
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// --- rollout discovery + subagent linkage -------------------------------------

/** A discovered rollout file with change-detection stats. */
export interface RolloutFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Recursively collect every `rollout-*.jsonl` under the Codex sessions dir. */
export function listRollouts(): RolloutFile[] {
  const out: RolloutFile[] = [];
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try {
          const st = statSync(full);
          out.push({ path: full, mtimeMs: Math.floor(st.mtimeMs), size: st.size });
        } catch {
          /* file vanished between readdir and stat; ignore */
        }
      }
    }
  };
  walk(codexSessionsDir());
  return out;
}

/** Read a file's first line (the `session_meta` record) without loading the whole
 *  rollout — the line can be tens of KB (it embeds the base instructions), so read
 *  in chunks up to a 1 MiB cap. */
function firstLine(path: string): string {
  const CHUNK = 64 * 1024;
  const CAP = 1024 * 1024;
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const buf = Buffer.alloc(CHUNK);
    let acc = '';
    let pos = 0;
    while (pos < CAP) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      acc += buf.toString('utf8', 0, n);
      const nl = acc.indexOf('\n');
      if (nl >= 0) return acc.slice(0, nl);
      pos += n;
    }
    return acc;
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/** Cross-file subagent linkage: subagent thread id → parent thread id. */
interface CodexContext {
  parents: Map<string, string>;
}

let ctxCache: { fp: string; ctx: CodexContext } | null = null;

/** Cheap fingerprint: every rollout's (path, mtime, size). */
function fingerprint(files: RolloutFile[]): string {
  return files
    .map((f) => `${f.path}:${f.mtimeMs}:${f.size}`)
    .sort()
    .join('|');
}

/**
 * The memoized subagent parent-map for the sessions dir, built by reading only
 * each rollout's first line (`session_meta` carries `thread_source` and
 * `source.subagent.thread_spawn.parent_thread_id`). Rebuilt only when a rollout
 * changes, so per-file `prepare`/`loadSession` calls in one reindex reuse one scan.
 */
export function getCodexContext(): CodexContext {
  const files = listRollouts();
  const fp = fingerprint(files);
  if (ctxCache && ctxCache.fp === fp) return ctxCache.ctx;
  const parents = new Map<string, string>();
  for (const f of files) {
    let meta: Record<string, unknown>;
    try {
      meta = rec(rec(JSON.parse(firstLine(f.path))).payload);
    } catch {
      continue;
    }
    if (str(meta.thread_source) !== 'subagent') continue;
    const spawn = rec(rec(rec(meta.source).subagent).thread_spawn);
    const id = str(meta.id) || str(meta.session_id);
    const parent = str(spawn.parent_thread_id);
    if (id && parent) parents.set(id, parent);
  }
  const ctx = { parents };
  ctxCache = { fp, ctx };
  return ctx;
}

/** Follow the parent chain to the top-level (non-subagent) thread. Mirrors the
 *  antigravity connector's `rootConvId` (cycle-guarded, multi-level nesting). */
export function rootThreadId(id: string, parents: Map<string, string>): string {
  let cur = id;
  const guard = new Set<string>();
  while (parents.has(cur) && !guard.has(cur)) {
    guard.add(cur);
    cur = parents.get(cur)!;
  }
  return cur;
}

/** First line of a subagent prompt, truncated — used as the correlation key AND
 *  label (mirrors the antigravity connector's `subagentLabel`). */
export function subagentLabel(prompt: string): string {
  const line = prompt.trim().split('\n')[0]?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

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

/** Coerce a parsed `arguments` value to a record (Codex sends a JSON object). */
function argsRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Render one argv element for display, quoting it when it carries whitespace or
 *  quotes so the joined command stays unambiguous (and copy-runnable). */
function quoteArg(v: unknown): string {
  const s = str(v);
  return s === '' || /[\s'"\\]/.test(s) ? JSON.stringify(s) : s;
}

const SHELL_TOOLS = new Set(['exec_command', 'shell', 'local_shell', 'container.exec']);

/**
 * Map a Codex `function_call` to a canonical `tool_use` block. Codex names its
 * tools its own way — the shell tool is `exec_command` (arg `cmd`, a string) on
 * recent CLIs or `shell` / `local_shell` (arg `command`, usually an argv array,
 * sometimes nested under `action`) on older ones. The web renderer and the
 * Files-changed extractor key off the Claude tool names (`Bash`/`Read`/`Edit`/…),
 * so without this every Codex tool renders as raw JSON with no syntax
 * highlighting. Canonicalize the shell tool to `Bash` (mirrors the
 * pi/copilot/opencode connectors) and `spawn_agent` to `Task` (its
 * `description`/`subagent_type` anchor the child rollout's nested run — see
 * `buildSubagentRuns`); other tools (`update_plan`, `write_stdin`, `wait_agent`,
 * MCP tools, …) — and any shell/spawn call whose payload we can't recover (e.g.
 * unparseable `arguments`) — pass through under their raw name so the payload
 * stays visible rather than collapsing to an empty block.
 */
function codexToolUse(name: string, input: unknown, id: string): ToolUseBlock {
  if (SHELL_TOOLS.has(name)) {
    const args = argsRecord(input);
    const action = argsRecord(args.action);
    // `||` (not `??`) so an empty `cmd` falls through to a populated `command`.
    const raw = args.cmd || args.command || action.command;
    const command = Array.isArray(raw) ? raw.map(quoteArg).join(' ') : str(raw);
    if (command) return { type: 'tool_use', id, name: 'Bash', input: { command } };
  }
  if (name === 'spawn_agent') {
    const args = argsRecord(input);
    const message = str(args.message);
    if (message) {
      return {
        type: 'tool_use',
        id,
        name: 'Task',
        input: {
          description: subagentLabel(message),
          subagent_type: str(args.agent_type),
          prompt: message,
        },
      };
    }
  }
  return { type: 'tool_use', id, name, input };
}

/**
 * Strip Codex's exec-output envelope (`Chunk ID: … / Wall time: … / Process exited
 * with code N / … / Output:`) down to the captured stdout, so a command's output
 * renders clean — and, for a file read (`cat`/`sed`/…), highlights like a file. A
 * non-zero exit keeps the full envelope (the exit code is then the failure signal),
 * and non-envelope output passes through untouched.
 */
function stripExecEnvelope(output: string): string {
  const m = output.match(
    /^Chunk ID: [^\n]*\nWall time: [^\n]*\nProcess exited with code (-?\d+)\n(?:[^\n]*\n)*?Output:\n?([\s\S]*)$/,
  );
  if (!m) return output;
  return Number(m[1]) === 0 ? m[2]! : output;
}

/** The `apply_patch`-style custom-tool output envelope (`Exit code: N / Wall
 *  time: … / Output:`) — group 1 is the exit code, group 2 the captured output. */
const CUSTOM_ENVELOPE_RE = /^Exit code: (-?\d+)\nWall time: [^\n]*\n(?:[^\n]*\n)*?Output:\n?([\s\S]*)$/;

/**
 * Strip the custom-tool output envelope down to the captured output on success —
 * the same rationale as {@link stripExecEnvelope}, which handles the different
 * `Chunk ID:` envelope of the shell tool. A non-zero exit keeps the full envelope.
 */
function stripCustomEnvelope(output: string): string {
  const m = output.match(CUSTOM_ENVELOPE_RE);
  if (!m) return output;
  return Number(m[1]) === 0 ? m[2]! : output;
}

// --- apply_patch → canonical edit blocks -------------------------------------

interface Hunk {
  oldText: string;
  newText: string;
}

interface PatchFile {
  op: 'add' | 'update' | 'delete';
  path: string;
  hunks: Hunk[];
}

/**
 * Parse Codex's V4A `apply_patch` envelope (`*** Begin Patch` / `*** Add File:` /
 * `*** Update File:` (+ optional `*** Move to:`) / `*** Delete File:` /
 * `*** End Patch`) into per-file sections. Within a section, `@@` starts a hunk
 * (content may also start one implicitly), ` ` = context, `-` = removed,
 * `+` = added — the same hunk semantics as the opencode connector's unified-diff
 * parser. Returns `[]` when the text isn't a patch (the caller then falls back to
 * a raw passthrough block).
 */
function parseApplyPatch(patch: string): PatchFile[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (!lines.some((l) => l.startsWith('*** Begin Patch'))) return [];
  const files: PatchFile[] = [];
  // Holders (not bare `let`s) so reads aren't reset by closure mutation in CFA.
  const fileRef: { cur: PatchFile | null } = { cur: null };
  const hunkRef: { cur: { old: string[]; neu: string[] } | null } = { cur: null };
  const flushHunk = (): void => {
    if (fileRef.cur && hunkRef.cur) {
      fileRef.cur.hunks.push({
        oldText: hunkRef.cur.old.join('\n'),
        newText: hunkRef.cur.neu.join('\n'),
      });
    }
    hunkRef.cur = null;
  };
  const openFile = (op: PatchFile['op'], path: string): void => {
    flushHunk();
    fileRef.cur = { op, path: path.trim(), hunks: [] };
    files.push(fileRef.cur);
  };
  for (const line of lines) {
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) {
      flushHunk();
      fileRef.cur = null;
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\*\*\* Add File: (.+)$/))) {
      openFile('add', m[1]!);
      continue;
    }
    if ((m = line.match(/^\*\*\* Update File: (.+)$/))) {
      openFile('update', m[1]!);
      continue;
    }
    if ((m = line.match(/^\*\*\* Delete File: (.+)$/))) {
      openFile('delete', m[1]!);
      continue;
    }
    if ((m = line.match(/^\*\*\* Move to: (.+)$/))) {
      // A rename: the Files-changed tab should show the resulting path.
      if (fileRef.cur) fileRef.cur.path = m[1]!.trim();
      continue;
    }
    if (line.startsWith('*** ')) continue; // e.g. `*** End of File`
    if (!fileRef.cur || fileRef.cur.op === 'delete') continue;
    if (line.startsWith('@@')) {
      flushHunk();
      hunkRef.cur = { old: [], neu: [] };
      continue;
    }
    const tag = line[0];
    if (tag !== ' ' && tag !== '-' && tag !== '+') continue;
    if (!hunkRef.cur) hunkRef.cur = { old: [], neu: [] }; // implicit hunk (V4A allows no `@@`)
    const body = line.slice(1);
    if (tag === ' ') {
      hunkRef.cur.old.push(body);
      hunkRef.cur.neu.push(body);
    } else if (tag === '-') {
      hunkRef.cur.old.push(body);
    } else {
      hunkRef.cur.neu.push(body);
    }
  }
  flushHunk();
  return files.filter((f) => f.path);
}

/** A concise per-file status for a fanned-out apply_patch result (mirrors the
 *  opencode connector — avoids repeating the multi-file summary on every block). */
function patchFileStatus(f: PatchFile): string {
  const verb = f.op === 'add' ? 'Created' : f.op === 'delete' ? 'Deleted' : 'Updated';
  return `${verb} ${f.path}`;
}

/** One parsed patch file → a canonical Write/Edit/MultiEdit tool_use block
 *  (the names + `file_path` input the Files-changed tab keys off). */
function patchFileToolUse(f: PatchFile, id: string): ToolUseBlock {
  if (f.op === 'add') {
    const content = f.hunks
      .map((h) => h.newText)
      .filter((t) => t.length > 0)
      .join('\n');
    return { type: 'tool_use', id, name: 'Write', input: { file_path: f.path, content } };
  }
  if (f.op === 'delete') {
    // V4A deletions carry no body, so there is no old content to show — an empty
    // Edit still registers the file in the Files-changed tab.
    return { type: 'tool_use', id, name: 'Edit', input: { file_path: f.path, old_string: '', new_string: '' } };
  }
  const edits = f.hunks.map((h) => ({ old_string: h.oldText, new_string: h.newText }));
  return { type: 'tool_use', id, name: 'MultiEdit', input: { file_path: f.path, edits } };
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
  const modelProvider = str(meta.model_provider) || undefined;

  // A `thread_source: "subagent"` rollout is re-parented under its ROOT thread
  // (multi-level: walk the cross-file parent map), so it folds into the parent
  // session in the index instead of surfacing as its own top-level session.
  let indexSessionId = sessionId;
  let isSidechain = false;
  let agentRole: string | undefined;
  if (str(meta.thread_source) === 'subagent') {
    const spawn = rec(rec(rec(meta.source).subagent).thread_spawn);
    const parentId = str(spawn.parent_thread_id);
    agentRole = str(spawn.agent_role) || undefined;
    if (parentId) {
      isSidechain = true;
      indexSessionId = rootThreadId(parentId, getCodexContext().parents);
    }
  }

  const events: (UserEvent | AssistantEvent)[] = [];
  let seq = 0;
  let wsSeq = 0;
  let prevUuid: string | null = null;
  let model = '';

  // spawn_agent correlation: call_id → Task meta (set at the call), promoted to
  // spawnedAgents keyed by the child thread id when the output names it.
  const pendingSpawns = new Map<string, { description: string; agentType: string }>();
  const spawnedAgents = new Map<string, { description: string; agentType: string }>();
  // apply_patch fan-out: call_id → the fanned block REFERENCES (they stay live
  // inside the flushed event), per-file statuses, and the raw patch text — so the
  // (single) custom_tool_call_output can pair a result to every block, or demote
  // the blocks back to raw passthrough when the patch was rejected.
  const patchFanout = new Map<string, { blocks: ToolUseBlock[]; statuses: string[]; raw: string }>();

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
    const base = { uuid, parentUuid: prevUuid, sessionId, timestamp: turnTs, cwd, isSidechain };
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
      const block = codexToolUse(str(pl.name), input, str(pl.call_id));
      if (str(pl.name) === 'spawn_agent' && block.name === 'Task') {
        const taskInput = block.input as { description: string; subagent_type: string };
        pendingSpawns.set(block.id, {
          description: taskInput.description,
          agentType: taskInput.subagent_type,
        });
      }
      blocks.push(block);
    } else if (kind === 'function_call_output') {
      open('user', ts);
      const callId = str(pl.call_id);
      const output = str(pl.output);
      const spawn = pendingSpawns.get(callId);
      if (spawn) {
        // The output names the spawned child thread: `{"agent_id": …, "nickname": …}`.
        try {
          const agentId = str(rec(JSON.parse(output)).agent_id);
          if (agentId) spawnedAgents.set(agentId, spawn);
        } catch {
          /* unparseable spawn output — the child will render detached */
        }
      }
      blocks.push({
        type: 'tool_result',
        tool_use_id: callId,
        content: stripExecEnvelope(output),
      });
    } else if (kind === 'custom_tool_call') {
      // Freeform tools (arguments arrive as a raw string). `apply_patch` fans out
      // to one canonical Write/Edit/MultiEdit block per touched file (mirrors the
      // opencode connector); other custom tools pass through under their raw name.
      open('assistant', ts);
      const name = str(pl.name);
      const callId = str(pl.call_id);
      const raw = str(pl.input);
      const patchFiles = name === 'apply_patch' ? parseApplyPatch(raw) : [];
      if (patchFiles.length > 0) {
        const fanned = patchFiles.map((f, i) =>
          patchFileToolUse(f, patchFiles.length === 1 ? callId : `${callId}#${i}`),
        );
        for (const b of fanned) blocks.push(b);
        patchFanout.set(callId, {
          blocks: fanned,
          statuses: patchFiles.map(patchFileStatus),
          raw,
        });
      } else {
        blocks.push({ type: 'tool_use', id: callId, name, input: { input: raw } });
      }
    } else if (kind === 'custom_tool_call_output') {
      open('user', ts);
      const callId = str(pl.call_id);
      const output = str(pl.output);
      const fan = patchFanout.get(callId);
      const exit = output.match(CUSTOM_ENVELOPE_RE);
      if (fan && exit && Number(exit[1]) !== 0) {
        // The patch was REJECTED — nothing on disk changed. Demote the fanned
        // canonical blocks back to raw apply_patch passthrough (no `file_path`,
        // so the Files-changed tab never lists untouched files — the same
        // failed-edit convention as the copilot connector) and surface the full
        // error output on each.
        for (const b of fan.blocks) {
          b.name = 'apply_patch';
          b.input = { input: fan.raw };
          blocks.push({ type: 'tool_result', tool_use_id: b.id, content: output, is_error: true });
        }
      } else if (fan && fan.blocks.length > 1) {
        // Per-file status, NOT the shared multi-file summary (which would
        // repeat identically on every fanned-out block).
        fan.blocks.forEach((b, i) =>
          blocks.push({ type: 'tool_result', tool_use_id: b.id, content: fan.statuses[i]! }),
        );
      } else {
        blocks.push({
          type: 'tool_result',
          tool_use_id: callId,
          content: stripCustomEnvelope(output),
        });
      }
    } else if (kind === 'tool_search_call') {
      open('assistant', ts);
      blocks.push({ type: 'tool_use', id: str(pl.call_id), name: 'tool_search', input: rec(pl.arguments) });
    } else if (kind === 'tool_search_output') {
      open('user', ts);
      blocks.push({
        type: 'tool_result',
        tool_use_id: str(pl.call_id),
        content: JSON.stringify(pl.tools ?? [], null, 1),
      });
    } else if (kind === 'web_search_call') {
      // No call_id and no paired output record — render the query/action alone.
      open('assistant', ts);
      blocks.push({ type: 'tool_use', id: `${sessionId}-ws-${wsSeq++}`, name: 'web_search', input: rec(pl.action) });
    }
  }
  flush();

  return { sessionId, indexSessionId, isSidechain, agentRole, cwd, gitBranch, modelProvider, events, spawnedAgents };
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
      // The ROOT thread id — a subagent rollout indexes under its parent session.
      session_id: session.indexSessionId,
      uuid: e.uuid,
      parent_uuid: e.parentUuid,
      role: msg.role,
      type: e.type,
      ts: e.timestamp,
      cwd: session.cwd,
      git_branch: session.gitBranch ?? null,
      model: (msg as { model?: string }).model ?? null,
      provider: e.type === 'assistant' ? (session.modelProvider ?? null) : null,
      input_tokens: num(usage?.input_tokens),
      output_tokens: num(usage?.output_tokens),
      cache_read_tokens: num(usage?.cache_read_input_tokens),
      cache_write_tokens: 0,
      service_tier: null,
      is_sidechain: session.isSidechain,
      tool_use_count: arr.filter((b) => b.type === 'tool_use').length,
      tool_names: toolNamesCsv(arr),
      tool_error_count: toolErrorCount(arr),
      text_content: text,
    };
  });
}
