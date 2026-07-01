/**
 * Google Antigravity session → canonical thread normalizer.
 *
 * Source layout: `<appDataDir>/brain/<conv-id>/.system_generated/logs/transcript_full.jsonl`
 * (the CLI's `~/.gemini/antigravity-cli/` and the desktop app's `~/.gemini/antigravity/`
 * share this shape). Each line is one step:
 * `{step_index, source, type, status, created_at, content, thinking?, tool_calls?}`.
 * Assistant prose lives in `content` (type `PLANNER_RESPONSE`), reasoning in a
 * PLAINTEXT `thinking` field (like pi — it renders in full), and tool *results*
 * arrive as SEPARATE later records (`VIEW_FILE`/`LIST_DIRECTORY`/`CODE_ACTION`),
 * correlated to their call by record type + order (there is no call/result id).
 *
 * Two quirks drive the design:
 *  - **cwd is out-of-band** — it isn't in the transcript; the sibling
 *    `<appDataDir>/history.jsonl` maps `conversationId → workspace`. Absent → the
 *    `(unknown — Antigravity)` bucket (mirrors Junie).
 *  - **subagents are separate conversations** — `invoke_subagent` spawns a fresh
 *    `brain/<sub-id>/…` transcript, linked to the parent only by text (the parent's
 *    `SYSTEM_MESSAGE` carries `sender=<sub-id>`; its prose names the child too). We
 *    build a child→parent map and RE-PARENT each subagent transcript under its root
 *    conversation (`is_sidechain=true`), so subagents don't surface as orphan
 *    sessions and the existing `buildSubagentRuns` nesting can anchor them to the
 *    parent's `invoke_subagent` call (mapped to a canonical `Task` tool_use).
 *
 * There are NO token counts anywhere (the per-conversation SQLite DB is opaque
 * protobuf), so every row carries zero usage and `message_id`/`forked_from` are
 * NULL — the cost path counts them once at zero. Cost is unavailable by design.
 *
 * STRICTLY READ-ONLY with respect to ~/.gemini — files are only ever read.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type {
  AssistantEvent,
  ContentBlock,
  MessageUsage,
  ToolUseBlock,
  UserEvent,
} from '@claudescope/shared';
import { toolNamesCsv } from '../tool-names.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
/** First non-empty string among the candidates (unlike `??`, skips `''`). */
const firstStr = (...vals: unknown[]): string => {
  for (const v of vals) {
    const s = str(v);
    if (s) return s;
  }
  return '';
};

/** Junie-style bucket for a session whose cwd can't be resolved. */
export const ANTIGRAVITY_UNKNOWN_CWD = '(unknown — Antigravity)';

/** One `transcript_full.jsonl` step record (schema-loose; unknown fields tolerated). */
interface AntigravityRecord {
  step_index?: number;
  source?: string; // USER_EXPLICIT | SYSTEM | MODEL
  type?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: { name?: string; args?: Record<string, unknown> }[];
}

const zeroUsage = (): MessageUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

// --- path helpers -----------------------------------------------------------
// `<appDataDir>/brain/<conv-id>/.system_generated/logs/transcript_full.jsonl`

/** conv-id (the `brain/<conv-id>` dir name) from a transcript path. */
function convIdFromPath(filePath: string): string {
  return basename(dirname(dirname(dirname(filePath))));
}
/** The appDataDir (parent of `brain/`) from a transcript path. */
export function appDataDirFromPath(filePath: string): string {
  return dirname(dirname(dirname(dirname(dirname(filePath)))));
}
/** The conversation dir (holds `uploaded_media_*.png`) from a transcript path. */
function convDirFromPath(filePath: string): string {
  return dirname(dirname(dirname(filePath)));
}

/** A discovered transcript file under one appDataDir. */
export interface AntigravityTranscript {
  convId: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/** Every `brain/<conv-id>/.system_generated/logs/transcript_full.jsonl` under `appDataDir`. */
export function listTranscripts(appDataDir: string): AntigravityTranscript[] {
  const brain = join(appDataDir, 'brain');
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(brain, { withFileTypes: true });
  } catch {
    return []; // no such appDataDir (surface not installed)
  }
  const out: AntigravityTranscript[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const path = join(brain, e.name, '.system_generated', 'logs', 'transcript_full.jsonl');
    try {
      const st = statSync(path);
      out.push({ convId: e.name, path, mtimeMs: Math.floor(st.mtimeMs), size: st.size });
    } catch {
      /* a conversation dir without a transcript yet; ignore */
    }
  }
  return out;
}

/** Parse a `transcript_full.jsonl` into step records, tolerating bad lines. */
function readRecords(path: string): AntigravityRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: AntigravityRecord[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as AntigravityRecord);
    } catch {
      /* tolerate a corrupt/partial line */
    }
  }
  return out;
}

// --- per-appDataDir context (history + subagent linkage), memoized -----------

interface SubagentLink {
  parentConvId: string;
  prompt: string;
  typeName: string;
}

interface AntigravityContext {
  /** conversationId → workspace (cwd). */
  history: Map<string, string>;
  /** subagent conv-id → its spawn linkage. */
  subagents: Map<string, SubagentLink>;
}

const SENDER_RE = /sender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const CONV_ID_RE =
  /Conversation ID[:=]?\s*`?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`?/i;

/** Read `history.jsonl` → conversationId → workspace (last workspace wins). */
function readHistory(appDataDir: string): Map<string, string> {
  const map = new Map<string, string>();
  let raw: string;
  try {
    raw = readFileSync(join(appDataDir, 'history.jsonl'), 'utf8');
  } catch {
    return map;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as { conversationId?: unknown; workspace?: unknown };
      const cid = str(r.conversationId);
      const ws = str(r.workspace);
      if (cid && ws) map.set(cid, ws);
    } catch {
      /* skip */
    }
  }
  return map;
}

/**
 * Scan every transcript under `appDataDir` for subagent spawns, returning a
 * child-conv-id → {parent, prompt, typeName} map. Within each conversation the
 * ordered `invoke_subagent` prompts are zipped against the ordered child ids it
 * references (via `SYSTEM_MESSAGE sender=` and "Conversation ID:" mentions).
 */
function buildSubagentMap(appDataDir: string): Map<string, SubagentLink> {
  const map = new Map<string, SubagentLink>();
  for (const t of listTranscripts(appDataDir)) {
    // Walk records in order, pairing each spawned subagent prompt with the next
    // child conv-id this conversation produces. Child ids come ONLY from a
    // SYSTEM_MESSAGE `sender=` (the child messaged this parent) or a
    // PLANNER_RESPONSE "Conversation ID: <id>" announcement — we deliberately do
    // NOT scan a SYSTEM_MESSAGE body with the id regex, since a relayed summary
    // may quote unrelated conversation ids and inflate the pairing.
    const pendingPrompts: { prompt: string; typeName: string }[] = [];
    const seen = new Set<string>();
    for (const r of readRecords(t.path)) {
      for (const call of r.tool_calls ?? []) {
        if (str(call.name) !== 'invoke_subagent') continue;
        const subs = rec(call.args).Subagents;
        for (const s of Array.isArray(subs) ? subs : []) {
          const sr = rec(s);
          pendingPrompts.push({ prompt: str(sr.Prompt), typeName: str(sr.TypeName) });
        }
      }
      const content = str(r.content);
      const childId =
        r.type === 'SYSTEM_MESSAGE'
          ? content.match(SENDER_RE)?.[1]
          : r.type === 'PLANNER_RESPONSE'
            ? content.match(CONV_ID_RE)?.[1]
            : undefined;
      if (!childId || childId === t.convId || seen.has(childId)) continue;
      seen.add(childId);
      const spawn = pendingPrompts.shift();
      if (spawn && !map.has(childId)) {
        map.set(childId, { parentConvId: t.convId, prompt: spawn.prompt, typeName: spawn.typeName });
      }
    }
  }
  return map;
}

/** Follow the parent chain to the top-level (non-subagent) conversation. Ids are
 *  compared as raw on-disk conv-ids throughout (map keys AND parentConvId), so the
 *  walk stays consistent for multi-level nesting. */
export function rootConvId(convId: string, subagents: Map<string, SubagentLink>): string {
  let cur = convId;
  const guard = new Set<string>();
  while (subagents.has(cur) && !guard.has(cur)) {
    guard.add(cur);
    cur = subagents.get(cur)!.parentConvId;
  }
  return cur;
}

const ctxCache = new Map<string, { fp: string; ctx: AntigravityContext }>();

/** Cheap fingerprint: history mtime + every transcript's (id, mtime, size). */
function fingerprint(appDataDir: string): string {
  let hist = 0;
  try {
    hist = Math.floor(statSync(join(appDataDir, 'history.jsonl')).mtimeMs);
  } catch {
    /* no history yet */
  }
  const ts = listTranscripts(appDataDir)
    .map((t) => `${t.convId}:${t.mtimeMs}:${t.size}`)
    .sort()
    .join('|');
  return `${hist}|${ts}`;
}

/**
 * The memoized history + subagent map for an appDataDir. Rebuilt only when a
 * transcript or `history.jsonl` changes (so per-file `prepare`/`loadSession`
 * calls in one reindex reuse a single scan).
 */
export function getContext(appDataDir: string): AntigravityContext {
  const fp = fingerprint(appDataDir);
  const cached = ctxCache.get(appDataDir);
  if (cached && cached.fp === fp) return cached.ctx;
  const ctx: AntigravityContext = {
    history: readHistory(appDataDir),
    subagents: buildSubagentMap(appDataDir),
  };
  ctxCache.set(appDataDir, { fp, ctx });
  return ctx;
}

/** Subagent metadata (agentType, matched description) for a transcript, if it's a child. */
export function subagentMetaFor(path: string): { agentType: string; description: string } | null {
  const link = getContext(appDataDirFromPath(path)).subagents.get(convIdFromPath(path));
  if (!link) return null;
  return { agentType: link.typeName, description: subagentLabel(link.prompt) };
}

// --- content cleaning -------------------------------------------------------

/** Unwrap `<USER_REQUEST>…</USER_REQUEST>` to the user's actual prose. */
function cleanUserRequest(content: string): string {
  const m = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return (m?.[1] ?? content).trim();
}

/** Human-readable model from a `<USER_SETTINGS_CHANGE>` blob ("… to <Name>. …"). */
function parseModel(content: string): string | null {
  const m = content.match(/Model Selection[\s\S]*?\bto\s+(.+?)\.\s/i);
  return m?.[1] ? m[1].trim() : null;
}

/** Extract the payload of a `SYSTEM_MESSAGE` (the text after `content=`). */
function extractSystemMessage(content: string): string {
  const idx = content.indexOf('content=');
  const body = idx >= 0 ? content.slice(idx + 'content='.length) : content;
  return body.replace(/<\/?SYSTEM_MESSAGE>/g, '').trim();
}

/** Absolute path referenced by a `file://…` link in a tool-result record. */
function extractFilePath(content: string): string {
  const m = content.match(/file:\/\/(\/[^\s`)]+)/);
  return m?.[1] ?? '';
}

/** First line of a subagent prompt, truncated — used as the correlation key AND label. */
export function subagentLabel(prompt: string): string {
  const line = prompt.trim().split('\n')[0]?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

// --- images -----------------------------------------------------------------

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Absolute `uploaded_media_*.png` paths listed in a USER_INPUT metadata blob.
 *  Accepts POSIX (`/…`) and Windows (`C:\…`) paths, including spaces — only the
 *  basename is used downstream, so the leading form doesn't matter. */
function extractImagePaths(content: string): string[] {
  const out: string[] = [];
  const re = /^\s*-\s+(.+\.(?:png|jpe?g|gif|webp))\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) if (m[1]) out.push(m[1].trim());
  return out;
}

/**
 * Resolve an uploaded image to a base64 `ImageBlock`. Contained to the
 * conversation dir: only ever reads `<convDir>/<basename>`, so a traversal path
 * can never escape it. Returns null for a non-image or a missing/oversized file.
 */
function resolveImage(convDir: string, absPath: string): ContentBlock | null {
  const name = basename(absPath);
  const mime = IMAGE_MIME[extname(name).toLowerCase()];
  if (!name || !mime) return null;
  try {
    const full = join(convDir, name);
    if (statSync(full).size > MAX_IMAGE_BYTES) return null;
    const data = readFileSync(full).toString('base64');
    return { type: 'image', source: { type: 'base64', media_type: mime, data } };
  } catch {
    return null;
  }
}

// --- tool mapping -----------------------------------------------------------

type ToolKind = 'read' | 'write' | 'list';

/** The typed result-record kind a canonical tool call expects, if any. */
function toolKind(name: string): ToolKind | null {
  if (name === 'Read') return 'read';
  if (name === 'Write') return 'write';
  if (name === 'list_dir') return 'list';
  return null;
}

/** The tool kind a result record represents (VIEW_FILE/CODE_ACTION/LIST_DIRECTORY). */
function resultKind(type: string): ToolKind | null {
  if (type === 'VIEW_FILE') return 'read';
  if (type === 'CODE_ACTION') return 'write';
  if (type === 'LIST_DIRECTORY') return 'list';
  return null;
}

/**
 * Map one Antigravity tool call to canonical `tool_use` block(s). `write_to_file`
 * → `Write` (feeds the Files-changed tab), `view_file` → `Read`, `invoke_subagent`
 * → one `Task` per spawned subagent (so `buildSubagentRuns` anchors each nested
 * run by description + type), shell-like tools → `Bash`; everything else passes
 * through under its raw name (already categorized by `categories.ts`).
 */
function toolUseBlocks(name: string, args: Record<string, unknown>, id: string): ToolUseBlock[] {
  switch (name) {
    case 'write_to_file':
      return [
        {
          type: 'tool_use',
          id,
          name: 'Write',
          input: { file_path: str(args.TargetFile), content: str(args.CodeContent) },
        },
      ];
    case 'view_file':
      return [
        {
          type: 'tool_use',
          id,
          name: 'Read',
          input: { file_path: firstStr(args.AbsolutePath, args.TargetFile, args.Path) },
        },
      ];
    case 'invoke_subagent': {
      const subs = args.Subagents;
      return (Array.isArray(subs) ? subs : []).map((s, k) => {
        const sr = rec(s);
        return {
          type: 'tool_use',
          id: `${id}-${k}`,
          name: 'Task',
          input: {
            description: subagentLabel(str(sr.Prompt)),
            subagent_type: str(sr.TypeName),
            prompt: str(sr.Prompt),
          },
        } as ToolUseBlock;
      });
    }
    default:
      if (/^(run[_-]?(command|terminal)|terminal|shell|exec)/i.test(name)) {
        return [
          {
            type: 'tool_use',
            id,
            name: 'Bash',
            input: { command: firstStr(args.Command, args.CommandLine, args.command) },
          },
        ];
      }
      return [{ type: 'tool_use', id, name, input: args }];
  }
}

/** Synthesize a call+result pair for a result record that had no preceding call. */
function synthToolUse(kind: ToolKind, content: string, id: string): ToolUseBlock {
  const name = kind === 'read' ? 'Read' : kind === 'write' ? 'Write' : 'list_dir';
  const path = extractFilePath(content);
  return { type: 'tool_use', id, name, input: name === 'list_dir' ? { path } : { file_path: path } };
}

// --- parse ------------------------------------------------------------------

export interface AntigravitySession {
  /** Indexing key: the root conversation id (the parent, for a subagent). */
  sessionId: string;
  /** This transcript's own conversation id. */
  convId: string;
  cwd: string;
  isSidechain: boolean;
  model: string | null;
  events: (UserEvent | AssistantEvent)[];
}

/**
 * Parse one `transcript_full.jsonl` into Claude-shaped events, re-parented under
 * its root conversation when it is a subagent. `resolveImages` (loadSession only)
 * reads uploaded-image bytes off disk; the index path leaves it off.
 */
export function parseAntigravitySession(
  filePath: string,
  opts: { resolveImages?: boolean } = {},
): AntigravitySession {
  const convId = convIdFromPath(filePath);
  const convDir = convDirFromPath(filePath);
  const ctx = getContext(appDataDirFromPath(filePath));

  const isSidechain = ctx.subagents.has(convId);
  const sessionId = isSidechain ? rootConvId(convId, ctx.subagents) : convId;
  const cwd = ctx.history.get(sessionId) ?? ANTIGRAVITY_UNKNOWN_CWD;
  const resolveImages = opts.resolveImages ?? false;

  // Sort by step_index, falling back to file (append) order for a record missing
  // it — so a step-less line keeps its position instead of being hoisted to 0.
  const records = readRecords(filePath)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.step_index ?? a.i) - (b.r.step_index ?? b.i))
    .map((x) => x.r);

  const events: (UserEvent | AssistantEvent)[] = [];
  let seq = 0;
  let toolSeq = 0;
  let prevUuid: string | null = null;
  let model: string | null = null;
  const nextUuid = (): string => `${convId}-${seq++}`;
  const nextToolId = (): string => `${convId}-tool-${toolSeq++}`;
  const envelope = (ts: string): Pick<
    UserEvent,
    'sessionId' | 'timestamp' | 'cwd' | 'isSidechain'
  > => ({ sessionId, timestamp: ts, cwd, isSidechain });

  const pending: Record<ToolKind, string[]> = { read: [], write: [], list: [] };

  const emitUser = (ts: string, blocks: ContentBlock[]): void => {
    if (blocks.length === 0) return;
    const uuid = nextUuid();
    events.push({
      uuid,
      parentUuid: prevUuid,
      ...envelope(ts),
      type: 'user',
      message: { role: 'user', content: blocks },
    } as UserEvent);
    prevUuid = uuid;
  };
  const emitAssistant = (ts: string, blocks: ContentBlock[]): void => {
    if (blocks.length === 0) return;
    const uuid = nextUuid();
    events.push({
      uuid,
      parentUuid: prevUuid,
      ...envelope(ts),
      type: 'assistant',
      message: {
        role: 'assistant',
        ...(model ? { model } : {}),
        content: blocks,
        usage: zeroUsage(),
      },
    } as AssistantEvent);
    prevUuid = uuid;
  };

  for (const r of records) {
    const type = str(r.type);
    const ts = str(r.created_at);
    const content = str(r.content);
    if (type === 'CHECKPOINT' || type === 'CONVERSATION_HISTORY') continue;

    if (type === 'USER_INPUT') {
      // A new user turn ends any prior tool loop; drop unmatched pending calls so
      // a later same-kind result can't attach across the turn boundary.
      pending.read.length = 0;
      pending.write.length = 0;
      pending.list.length = 0;
      const mm = parseModel(content);
      if (mm) model = mm;
      const blocks: ContentBlock[] = [];
      const text = cleanUserRequest(content);
      if (text) blocks.push({ type: 'text', text });
      if (resolveImages) {
        for (const p of extractImagePaths(content)) {
          const img = resolveImage(convDir, p);
          if (img) blocks.push(img);
        }
      }
      emitUser(ts, blocks);
      continue;
    }

    if (type === 'PLANNER_RESPONSE') {
      const blocks: ContentBlock[] = [];
      if (str(r.thinking)) blocks.push({ type: 'thinking', thinking: str(r.thinking) });
      if (content) blocks.push({ type: 'text', text: content });
      for (const call of r.tool_calls ?? []) {
        for (const tub of toolUseBlocks(str(call.name), rec(call.args), nextToolId())) {
          blocks.push(tub);
          const k = toolKind(tub.name);
          if (k) pending[k].push(tub.id);
        }
      }
      emitAssistant(ts, blocks);
      continue;
    }

    const rk = resultKind(type);
    if (rk) {
      const id = pending[rk].shift();
      if (id) {
        emitUser(ts, [{ type: 'tool_result', tool_use_id: id, content }]);
      } else if (rk === 'write') {
        // Orphan write result: the written content isn't in the result record, so
        // don't synthesize a canonical Write (it would render a blank/emptied diff
        // in the Files-changed tab). Surface the result text instead.
        emitAssistant(ts, [{ type: 'text', text: content }]);
      } else {
        const tid = nextToolId();
        emitAssistant(ts, [synthToolUse(rk, content, tid)]);
        emitUser(ts, [{ type: 'tool_result', tool_use_id: tid, content }]);
      }
      continue;
    }

    if (type === 'SYSTEM_MESSAGE') {
      const text = extractSystemMessage(content);
      if (text) emitUser(ts, [{ type: 'text', text }]);
      continue;
    }

    // GENERIC and any unknown record: surface its text on the side that produced it.
    if (content) {
      if (str(r.source) === 'USER_EXPLICIT') emitUser(ts, [{ type: 'text', text: content }]);
      else emitAssistant(ts, [{ type: 'text', text: content }]);
    }
  }

  return { sessionId, convId, cwd, isSidechain, model, events };
}

// --- canonical index rows ---------------------------------------------------

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
}

/** Flatten a parsed session into canonical index rows for one file. */
export function toCanonicalRows(session: AntigravitySession, filePath: string): CanonicalRow[] {
  return session.events.map((e) => {
    const msg = e.message;
    const content = Array.isArray(msg.content) ? msg.content : [];
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
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      service_tier: null,
      is_sidechain: session.isSidechain,
      tool_use_count: content.filter((b) => b.type === 'tool_use').length,
      tool_names: toolNamesCsv(content),
      text_content: text,
    };
  });
}
