/**
 * JetBrains Junie session → canonical thread normalizer.
 *
 * Junie does NOT store a conversational message log. A session is an
 * event-sourced UI render stream (`session-<id>/events.jsonl`): top-level
 * `UserPromptEvent`s interleaved with `SessionA2uxEvent` wrappers around nested
 * `agentEvent`s (status spinners, block updates, LLM usage). This parses one
 * session into Claude-shaped `RawEvent[]` — alternating user/assistant turns
 * whose `message.content` carries text / tool_use / tool_result / image blocks —
 * so the existing thread assembler and the canonical index row builder reuse it.
 *
 * Translation model:
 *   - Each top-level `UserPromptEvent` opens a user turn (its `prompt` text plus
 *     any pasted clipboard images, base64-inlined). It also flushes the pending
 *     assistant turn.
 *   - Everything between two user prompts is one assistant turn. Block events
 *     (`Tool`/`Terminal`/`ViewFiles`/`FileChanges`BlockUpdatedEvent) are
 *     coalesced by `stepId` (they're emitted repeatedly IN_PROGRESS→COMPLETED;
 *     last write wins) into one tool_use + tool_result pair each. The trailing
 *     `ResultBlockUpdatedEvent.result` becomes the assistant's final text block.
 *   - Token usage is summed from the turn's `LlmResponseMetadataEvent.modelUsage`
 *     entries; the model is the last one seen.
 *
 * STRICTLY READ-ONLY with respect to ~/.junie — files are only ever read.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import type {
  AssistantEvent,
  ContentBlock,
  ImageBlock,
  MessageUsage,
  UserEvent,
} from '@claudescope/shared';
import { JUNIE_HOME } from '../../config.js';

export interface JunieSession {
  sessionId: string;
  cwd: string;
  title: string;
  events: (UserEvent | AssistantEvent)[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** cwd shown for sessions Junie never recorded a directory for. */
const UNKNOWN_CWD = '(unknown — Junie)';

/** Mutable per-turn token accumulator (assignable to {@link MessageUsage}). */
interface JunieUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  [k: string]: number;
}
const zeroUsage = (): JunieUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

/** A logical agent step, merged across the block events that share its stepId. */
interface StepAgg {
  order: number;
  /** Human label from a ToolBlockUpdatedEvent (e.g. "Open README.rst"). */
  label?: string;
  /** Shell command from a TerminalBlockUpdatedEvent. */
  command?: string;
  /** File ranges from a ViewFilesBlockUpdatedEvent. */
  files?: unknown[];
  /** Edits from a FileChangesBlockUpdatedEvent. */
  changes?: Record<string, unknown>[];
  /** Output/details text shown under the block. */
  details?: string;
  status?: string;
}

/** Image extensions we will inline (anything else is refused, not read). */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** Real path of Junie's home dir, resolved once; attachment reads are confined here. */
let junieRootReal: string | null = null;
function junieRoot(): string {
  if (junieRootReal === null) {
    try {
      junieRootReal = realpathSync(JUNIE_HOME);
    } catch {
      junieRootReal = JUNIE_HOME; // home absent — containment check below just won't match
    }
  }
  return junieRootReal;
}

/**
 * Map an absolute image path to an inlined base64 ImageBlock, or null.
 *
 * The path comes from transcript content (`customAttachments` / `@`-mentions),
 * so it is UNTRUSTED: a poisoned session could name `/Users/you/.ssh/id_rsa` or
 * `../../etc/passwd`. We therefore (1) require an image extension and (2) resolve
 * the real path and refuse anything that escapes Junie's own home dir — the only
 * tree this connector is ever allowed to read.
 */
function imageBlockFromPath(path: string): ImageBlock | null {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (!IMAGE_EXTS.has(ext)) return null; // not an image we inline
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null; // image vanished, unreadable, or a broken symlink — skip it
  }
  const root = junieRoot();
  if (real !== root && !real.startsWith(root + sep)) return null; // outside ~/.junie — refuse
  try {
    const data = readFileSync(real).toString('base64');
    const mediaType =
      ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'gif'
          ? 'image/gif'
          : ext === 'webp'
            ? 'image/webp'
            : 'image/png';
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  } catch {
    return null; // unreadable after resolution — skip it
  }
}

/** Image blocks for a UserPromptEvent's string-path attachments (objects skipped). */
function attachmentImages(customAttachments: unknown): ImageBlock[] {
  if (!Array.isArray(customAttachments)) return [];
  const out: ImageBlock[] = [];
  for (const a of customAttachments) {
    if (typeof a === 'string' && isAbsolute(a)) {
      const img = imageBlockFromPath(a);
      if (img) out.push(img);
    }
  }
  return out;
}

// Junie embeds a pasted screenshot as an `@<absolute-path>.png` mention in the
// prompt text (not always in customAttachments). Match an absolute path with an
// image extension — POSIX (`/…`) or Windows (`C:\…` / `C:/…`) — so it can be
// inlined and the raw path cleaned from the text. `\S` stops at whitespace
// (a pre-existing limitation: paths with spaces aren't matched).
const IMAGE_MENTION_RE = /@((?:[A-Za-z]:[\\/]|\/)\S+?\.(?:png|jpe?g|gif|webp))\b/gi;

/**
 * Pull `@<image-path>` mentions out of a prompt: inline each as an ImageBlock
 * when the file still exists (Junie purges clipboard images fast), and replace
 * the raw path token with a readable marker so it never leaks into the rendered
 * text. Returns the cleaned text and any embedded images.
 */
function extractPromptImages(prompt: string): { text: string; images: ImageBlock[] } {
  const images: ImageBlock[] = [];
  const text = prompt.replace(IMAGE_MENTION_RE, (_match, path: string) => {
    const name = path.split(/[/\\]/).pop() || 'image';
    const img = imageBlockFromPath(path);
    if (img) {
      images.push(img);
      return `[image: ${name}]`;
    }
    return `[image: ${name} (unavailable)]`;
  });
  return { text, images };
}

/** Plain text of a Junie FileContent object (`{kind, text}`), or '' if absent. */
function fileContentText(c: unknown): string {
  if (!c || typeof c !== 'object') return '';
  return str((c as Record<string, unknown>).text);
}

/**
 * One `Edit` tool_use + tool_result per changed file in a FileChanges step. The
 * `file_path` / `old_string` / `new_string` shape is what the web changeset
 * extractor (and the Files-changed tab) recognizes, so Junie's edits get real
 * diffs and +/- counts; Junie stores the full before/after content per file.
 */
function changeBlocks(stepId: string, changes: Record<string, unknown>[], sessionId: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  changes.forEach((c, i) => {
    const path = str(c.afterRelativePath) || str(c.beforeRelativePath);
    if (!path) return;
    const kind = !c.beforeRelativePath ? 'created' : !c.afterRelativePath ? 'deleted' : 'modified';
    const id = `${sessionId}-step-${stepId}-${i}`;
    blocks.push({
      type: 'tool_use',
      id,
      name: 'Edit',
      input: {
        file_path: path,
        old_string: fileContentText(c.beforeContent),
        new_string: fileContentText(c.afterContent),
      },
    });
    blocks.push({ type: 'tool_result', tool_use_id: id, content: `${kind}: ${path}` });
  });
  return blocks;
}

/** Derive tool_use + tool_result blocks for one coalesced step. */
function stepToBlocks(stepId: string, agg: StepAgg, sessionId: string): ContentBlock[] {
  // File edits become standard Edit blocks (one per file) so they flow into the
  // changeset/Files-changed tab — distinct from the other block kinds below.
  if (agg.changes && agg.changes.length > 0) {
    return changeBlocks(stepId, agg.changes, sessionId);
  }

  const id = `${sessionId}-step-${stepId}`;
  let name: string;
  const input: Record<string, unknown> = {};
  const resultText = agg.details ?? '';

  if (agg.command) {
    name = 'terminal';
    input.command = agg.command;
  } else if (agg.files && agg.files.length > 0) {
    name = 'view';
    input.files = agg.files;
    if (agg.label) input.label = agg.label;
  } else {
    name = 'tool';
    if (agg.label) input.action = agg.label;
  }
  if (agg.status) input.status = agg.status;

  return [
    { type: 'tool_use', id, name, input },
    { type: 'tool_result', tool_use_id: id, content: resultText },
  ];
}

interface IndexMeta {
  title: string;
  cwd: string;
  /** ISO timestamp from `createdAt`, used to seed turns Junie left untimestamped. */
  createdAt: string;
}

/** Look up a session's metadata (title, projectDir, createdAt) from index.jsonl. */
function readIndexMeta(eventsPath: string, sessionId: string): IndexMeta {
  const empty: IndexMeta = { title: '', cwd: '', createdAt: '' };
  const indexPath = join(dirname(dirname(eventsPath)), 'index.jsonl');
  let raw: string;
  try {
    raw = readFileSync(indexPath, 'utf8');
  } catch {
    return empty;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (str(o.sessionId) === sessionId) {
        const created = num(o.createdAt);
        return {
          title: str(o.taskName),
          cwd: str(o.projectDir),
          createdAt: created > 0 ? new Date(created).toISOString() : '',
        };
      }
    } catch {
      /* tolerate a corrupt index line */
    }
  }
  return empty;
}

/** Parse a Junie session's events.jsonl into a Claude-shaped session, or null. */
export function parseSession(eventsPath: string): JunieSession | null {
  let raw: string;
  try {
    raw = readFileSync(eventsPath, 'utf8');
  } catch {
    return null;
  }

  const sessionId = basename(dirname(eventsPath));
  const meta = readIndexMeta(eventsPath, sessionId);
  let cwd = meta.cwd;
  let title = meta.title;

  const events: (UserEvent | AssistantEvent)[] = [];
  let seq = 0;
  let prevUuid: string | null = null;
  // Seed with the session's createdAt so the leading turns — which Junie emits
  // before the first timestamped event — still carry a sortable timestamp.
  let lastTs = meta.createdAt;

  // Open assistant-turn buffer.
  let assistantOpen = false;
  let steps = new Map<string, StepAgg>();
  // ResultBlockUpdatedEvent text, keyed by stepId so a later update of the same
  // step replaces (not duplicates) its earlier streamed text.
  let resultSteps = new Map<string, string>();
  let usage = zeroUsage();
  let model = '';
  let turnTs = '';

  const flushAssistant = (): void => {
    if (!assistantOpen) return;
    const blocks: ContentBlock[] = [];
    for (const [stepId, agg] of steps) {
      for (const b of stepToBlocks(stepId, agg, sessionId)) blocks.push(b);
    }
    const finalText = [...resultSteps.values()].join('\n\n').trim();
    if (finalText) blocks.push({ type: 'text', text: finalText });

    // Reset the buffer before a possible early return so state never leaks.
    const hadContent = blocks.length > 0;
    const turnUsage: MessageUsage = usage;
    const turnModel = model;
    const ts = turnTs || lastTs;
    assistantOpen = false;
    steps = new Map();
    resultSteps = new Map();
    usage = zeroUsage();
    model = '';
    turnTs = '';
    if (!hadContent) return;

    const uuid = `${sessionId}-${seq++}`;
    events.push({
      uuid,
      parentUuid: prevUuid,
      sessionId,
      timestamp: ts,
      cwd: cwd || UNKNOWN_CWD,
      isSidechain: false,
      type: 'assistant',
      message: { role: 'assistant', model: turnModel, content: blocks, usage: turnUsage },
    } as AssistantEvent);
    prevUuid = uuid;
  };

  const pushUser = (prompt: string, images: ImageBlock[]): void => {
    const content: ContentBlock[] = [];
    if (prompt) content.push({ type: 'text', text: prompt });
    for (const img of images) content.push(img);
    if (content.length === 0) return;
    const uuid = `${sessionId}-${seq++}`;
    events.push({
      uuid,
      parentUuid: prevUuid,
      sessionId,
      timestamp: lastTs,
      cwd: cwd || UNKNOWN_CWD,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content },
    } as UserEvent);
    prevUuid = uuid;
  };

  const ensureAssistant = (): void => {
    if (!assistantOpen) {
      assistantOpen = true;
      turnTs = lastTs;
    }
  };

  /** Merge one block event's fields into the step keyed by its stepId. */
  const mergeStep = (ae: Record<string, unknown>): void => {
    const stepId = str(ae.stepId);
    if (!stepId) return;
    ensureAssistant();
    const agg = steps.get(stepId) ?? { order: steps.size };
    if (typeof ae.text === 'string') agg.label = ae.text;
    if (typeof ae.command === 'string') agg.command = ae.command;
    if (Array.isArray(ae.files)) agg.files = ae.files;
    if (Array.isArray(ae.changes)) agg.changes = ae.changes as Record<string, unknown>[];
    if (typeof ae.details === 'string' && ae.details) agg.details = ae.details;
    if (typeof ae.status === 'string') agg.status = ae.status;
    steps.set(stepId, agg);
  };

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // tolerate a corrupt/partial line
    }
    const kind = str(o.kind);

    if (kind === 'UserPromptEvent') {
      flushAssistant();
      const { text, images } = extractPromptImages(str(o.prompt));
      pushUser(text, [...images, ...attachmentImages(o.customAttachments)]);
      continue;
    }
    if (kind !== 'SessionA2uxEvent') continue; // SendToAgentEvent, TaskState, … are markers

    const ts = num(o.timestampMs);
    if (ts > 0) lastTs = new Date(ts).toISOString();

    const ev = (o.event ?? {}) as Record<string, unknown>;
    const ae = (ev.agentEvent ?? {}) as Record<string, unknown>;
    const aeKind = str(ae.kind);

    switch (aeKind) {
      case 'LlmResponseMetadataEvent': {
        ensureAssistant();
        const mu = Array.isArray(ae.modelUsage) ? ae.modelUsage : [];
        for (const m of mu) {
          if (!m || typeof m !== 'object') continue;
          const u = m as Record<string, unknown>;
          usage.input_tokens += num(u.inputTokens);
          usage.output_tokens += num(u.outputTokens);
          usage.cache_read_input_tokens += num(u.cacheInputTokens);
          usage.cache_creation_input_tokens += num(u.cacheCreateTokens);
          if (str(u.model)) model = str(u.model);
        }
        break;
      }
      case 'AgentTaskNameUpdatedEvent':
        if (str(ae.name)) title = str(ae.name);
        break;
      case 'CurrentDirectoryUpdatedEvent':
        if (!cwd && str(ae.currentDirectory)) cwd = str(ae.currentDirectory);
        break;
      case 'ResultBlockUpdatedEvent':
        ensureAssistant();
        if (str(ae.result)) resultSteps.set(str(ae.stepId), str(ae.result));
        break;
      case 'ToolBlockUpdatedEvent':
      case 'TerminalBlockUpdatedEvent':
      case 'ViewFilesBlockUpdatedEvent':
      case 'FileChangesBlockUpdatedEvent':
        mergeStep(ae);
        break;
      default:
        break; // status spinners, state blobs, context reports, tips — ignored
    }
  }
  flushAssistant();

  // Title fallback: AgentTaskNameUpdatedEvent / index taskName already applied;
  // if still empty the generic first-user-message fallback in the indexer wins.
  return { sessionId, cwd: cwd || UNKNOWN_CWD, title, events };
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
  /** Not a canonical column — read separately by the title aux projection. */
  title: string;
}

/** Flatten a parsed session into canonical index rows for one file. */
export function toCanonicalRows(session: JunieSession, filePath: string): CanonicalRow[] {
  return session.events.map((e) => {
    const msg = (e as AssistantEvent | UserEvent).message;
    const arr = Array.isArray(msg.content) ? msg.content : [];
    const usage = (msg as { usage?: MessageUsage }).usage;
    // Text + tool labels feed full-text search; base64 image data is excluded.
    const text = arr
      .map((b) =>
        b.type === 'text'
          ? b.text
          : b.type === 'tool_use'
            ? `${b.name} ${JSON.stringify(b.input)}`
            : '',
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
      git_branch: null,
      model: (msg as { model?: string }).model ?? null,
      input_tokens: num(usage?.input_tokens),
      output_tokens: num(usage?.output_tokens),
      cache_read_tokens: num(usage?.cache_read_input_tokens),
      cache_write_tokens: num(usage?.cache_creation_input_tokens),
      service_tier: null,
      is_sidechain: false,
      tool_use_count: arr.filter((b) => b.type === 'tool_use').length,
      text_content: text,
      title: session.title,
    };
  });
}
