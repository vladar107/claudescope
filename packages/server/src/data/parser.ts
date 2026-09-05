/**
 * Session-detail thread assembler.
 *
 * A small TypeScript parser that turns the raw event stream of a single session
 * into an ordered {@link ThreadItem}[]. It handles:
 *   - `message.content` being a plain string OR an array of blocks;
 *   - normalizing `tool_result.content` (string OR block array) to blocks;
 *   - pairing each `tool_use` with its later `tool_result` (by `tool_use_id`),
 *     even when the result arrives in a subsequent user turn;
 *   - attachment events;
 *   - the `isSidechain` flag and usage/model/timestamp metadata;
 *   - stamping a context compaction onto the turn that follows it.
 *
 * The pairing is done in a second pass: tool_use blocks are emitted inline in
 * the assistant turn where they occur, and the matching tool_result (which the
 * transcript records inside a later user message) is folded into that same
 * {@link ToolInteraction} rather than shown as a standalone block.
 */

import type {
  AssistantEvent,
  CompactionInfo,
  ContentBlock,
  MessageUsage,
  RawEvent,
  SubagentRun,
  SystemEvent,
  ThreadBlock,
  ThreadItem,
  ToolInteraction,
  UserEvent,
} from '@claudescope/shared';
import type { SubagentSource } from './session-loader.js';

/** Narrow a raw event to a conversational (user/assistant) event. */
function isConversational(e: RawEvent): e is UserEvent | AssistantEvent {
  return e.type === 'user' || e.type === 'assistant';
}

/**
 * A compaction marker: Claude Code writes it natively, the Codex/pi/Copilot
 * normalizers synthesize the same shape.
 */
function isCompactBoundary(e: RawEvent): e is SystemEvent {
  return e.type === 'system' && e.subtype === 'compact_boundary';
}

/** Token counts on disk are unvalidated — only keep a sane number. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Build the display info for a compaction from its boundary event. */
function compactionFrom(event: SystemEvent): CompactionInfo {
  const info: CompactionInfo = {};
  const meta = event.compactMetadata;
  if (meta) {
    if (typeof meta.trigger === 'string') info.trigger = meta.trigger;
    const pre = tokenCount(meta.preTokens);
    if (pre !== undefined) info.preTokens = pre;
    const post = tokenCount(meta.postTokens);
    if (post !== undefined) info.postTokens = post;
  }
  if (typeof event.summary === 'string' && event.summary.length > 0) info.summary = event.summary;
  return info;
}

/**
 * Context size (the full prompt) at an assistant turn, or 0 when the turn
 * carries no usage — which is what "unknown" looks like here.
 */
function promptTokens(item: ThreadItem | undefined): number {
  const usage = item?.role === 'assistant' ? item.usage : undefined;
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/** Walk `items` from `from` in `step` direction for the first known context size. */
function nearestPromptTokens(items: ThreadItem[], from: number, step: -1 | 1): number {
  for (let i = from; i >= 0 && i < items.length; i += step) {
    const tokens = promptTokens(items[i]);
    if (tokens > 0) return tokens;
  }
  return 0;
}

/**
 * Fill in the context sizes the agent did not record on the boundary itself,
 * from the turns around the compaction: the last prompt before it and the
 * first one after it (the stamped turn counts when it is an assistant turn).
 */
function deriveCompactionTokens(items: ThreadItem[]): void {
  for (const [index, item] of items.entries()) {
    const { compaction } = item;
    if (!compaction) continue;
    if (compaction.preTokens === undefined) {
      const pre = nearestPromptTokens(items, index - 1, -1);
      if (pre > 0) compaction.preTokens = pre;
    }
    if (compaction.postTokens === undefined) {
      const post = nearestPromptTokens(items, index, 1);
      if (post > 0) compaction.postTokens = post;
    }
  }
}

/**
 * A conversational event's `message.content`, or `null` when the row can't
 * supply one.
 *
 * Transcripts are parsed with `JSON.parse(...) as RawEvent` — no shape
 * validation — so a `user`/`assistant` row may carry no `message` at all, or a
 * `content` that is neither a string nor an array. The indexer's SQL already
 * tolerates exactly this (`WHEN message IS NULL THEN …` in the Claude Code
 * projection), so such rows DO get indexed; the session then appeared in Browse
 * and the detail route 500'd on `Cannot read properties of undefined`. Returning
 * null makes the row produce no blocks, which the assembler already skips.
 */
function messageContent(event: UserEvent | AssistantEvent): string | ContentBlock[] | null {
  const content = (event as { message?: { content?: unknown } }).message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? (content as ContentBlock[]) : null;
}

/** Normalize tool_result.content (string | ContentBlock[]) to ContentBlock[]. */
function normalizeResultContent(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) return content;
  return [];
}

/**
 * Assemble ordered thread items from a session's raw events.
 *
 * The input is expected in file order (which is chronological / append order).
 * Sidechain events should already be merged into `events` by the caller; their
 * `isSidechain` flag is preserved on each item.
 */
/** Options for {@link assembleThread} / {@link buildSubagentRuns}. */
export interface AssembleOptions {
  /**
   * Fill a compaction's missing before/after sizes from the adjacent assistant
   * turns' usage. Default true; the caller turns it off for an agent whose
   * per-turn usage is not a prompt size (Copilot attaches its session total to
   * the last turn — see data/agent-capabilities.ts), where a derived figure
   * would be a real-looking number that measures nothing.
   */
  deriveContextSizes?: boolean;
}

export function assembleThread(events: RawEvent[], opts: AssembleOptions = {}): ThreadItem[] {
  const convo = events.filter(isConversational);

  // Pass 1: index every tool_result by tool_use_id so tool_use blocks can be
  // paired with their (later) result regardless of which turn carries it.
  const resultsByToolUseId = new Map<
    string,
    { isError: boolean; content: ContentBlock[] }
  >();
  for (const event of convo) {
    const content = messageContent(event);
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_result') {
        resultsByToolUseId.set(block.tool_use_id, {
          isError: block.is_error ?? false,
          content: normalizeResultContent(block.content),
        });
      }
    }
  }

  const items: ThreadItem[] = [];
  // A compaction seen in the stream but not yet attached to a rendered turn.
  // Turns that produce no blocks never consume it, so it lands on the first
  // turn the transcript actually shows after the boundary.
  let pending: CompactionInfo | undefined;
  // The flagged summary turn just pushed, until another turn follows it. A
  // mid-period Claude Code file writes BOTH a boundary and a flagged summary
  // for ONE compaction, and subagent files are timestamp-sorted on load, which
  // can put the summary (stamped a few hundred ms earlier) BEFORE its boundary
  // — so the merge has to work in either order.
  let openSummary: ThreadItem | undefined;

  // Pass 2 walks the FULL stream: the compaction markers are `system` rows,
  // which sit between the conversational ones.
  for (const event of events) {
    if (isCompactBoundary(event)) {
      const info = compactionFrom(event);
      if (openSummary) {
        openSummary.compaction = { ...openSummary.compaction, ...info };
        openSummary = undefined;
      } else {
        pending = info;
      }
      continue;
    }
    if (!isConversational(event)) continue;

    const blocks = parseBlocks(event, resultsByToolUseId);

    // Skip turns that contain only tool_result blocks (those are folded into
    // the preceding assistant turn's ToolInteraction) and produced no blocks.
    // This is also what makes the `event.message.*` reads below safe: a row with
    // no usable `message` yields no blocks (see messageContent) and exits here.
    if (blocks.length === 0) continue;

    const item: ThreadItem = {
      uuid: event.uuid,
      parentUuid: event.parentUuid,
      role: event.message.role,
      timestamp: event.timestamp,
      isSidechain: event.isSidechain ?? false,
      blocks,
    };
    if (event.type === 'assistant') {
      if (event.message.model !== undefined) item.model = event.message.model;
      if (event.message.usage !== undefined) item.usage = event.message.usage;
    }
    if (event.type === 'user' && event.isCompactSummary === true) {
      item.compaction = { ...pending, isSummaryTurn: true };
      pending = undefined;
      openSummary = item;
    } else {
      openSummary = undefined;
      if (pending) {
        item.compaction = pending;
        pending = undefined;
      }
    }
    items.push(item);
  }

  if (opts.deriveContextSizes !== false) deriveCompactionTokens(items);

  return items;
}

/** Tool names whose tool_use spawns a subagent run. */
const SUBAGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

/** Total input + output + cache tokens for a turn's usage. */
function usageTokens(usage?: MessageUsage): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Sum usage across a subagent's raw events, one addend per billed API call.
 *
 * Claude Code writes one row per content block of an assistant message, and
 * every row of that message shares the same `message.id` and repeats the
 * FULL `usage` object — summing per-row (as the assembled thread does per
 * {@link ThreadItem}) multiplies a single API call's usage by its block
 * count. Mirrors the SQL election in `electCanonicalUsage` (index.ts): within
 * a `message.id` group, the row with the largest `output_tokens` wins, since
 * only output grows across a streamed group (ties keep the first seen).
 * Events without a `message.id` count individually.
 */
function subagentUsageTokens(events: RawEvent[]): number {
  const byMessageId = new Map<string, MessageUsage>();
  let total = 0;
  for (const e of events) {
    // Like messageContent(), tolerate a row with no `message` at all.
    if (e.type !== 'assistant' || !e.message?.usage) continue;
    const usage = e.message.usage;
    const id = e.message.id;
    if (id === undefined) {
      total += usageTokens(usage);
      continue;
    }
    const current = byMessageId.get(id);
    if (!current || (usage.output_tokens ?? 0) > (current.output_tokens ?? 0)) {
      byMessageId.set(id, usage);
    }
  }
  for (const usage of byMessageId.values()) total += usageTokens(usage);
  return total;
}

interface SpawnPoint {
  toolUseId: string;
  spawnUuid: string;
  /** agentId of the run whose thread holds the call; undefined = main thread. */
  owner?: string;
  description?: string;
  subagentType?: string;
  prompt?: string;
  used: boolean;
}

interface WorkflowSpawn {
  toolUseId: string;
  spawnUuid: string;
  owner?: string;
  /** Concatenated tool-result text — searched for the workflow run id. */
  resultText: string;
}

/** Collect the spawn points of one thread (the main thread or a run's). */
function collectSpawns(
  thread: ThreadItem[],
  owner: string | undefined,
  spawns: SpawnPoint[],
  workflowSpawns: WorkflowSpawn[],
): void {
  for (const item of thread) {
    for (const block of item.blocks) {
      if (block.kind !== 'tool') continue;
      if (SUBAGENT_TOOL_NAMES.has(block.name)) {
        const input = (block.input ?? {}) as Record<string, unknown>;
        spawns.push({
          toolUseId: block.id,
          spawnUuid: item.uuid,
          owner,
          description: typeof input.description === 'string' ? input.description : undefined,
          subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
          prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
          used: false,
        });
      } else if (block.name === 'Workflow') {
        workflowSpawns.push({
          toolUseId: block.id,
          spawnUuid: item.uuid,
          owner,
          resultText: resultText(block),
        });
      }
    }
  }
}

/**
 * Break parent cycles (A spawned in B's thread, B in A's) by unlinking the run
 * whose pointer closes the cycle. Not producible by a real harness, but a
 * corrupt or hand-edited id must never make a consumer walking
 * `parentAgentId` chains loop forever — and a run whose chain merely passes
 * through a cycle keeps its own link.
 */
function breakParentCycles(runs: SubagentRun[]): void {
  const byId = new Map(runs.map((r) => [r.agentId, r]));
  const settled = new Set<string>();
  for (const start of runs) {
    if (settled.has(start.agentId)) continue;
    const path: SubagentRun[] = [];
    const onPath = new Set<string>();
    let cur: SubagentRun | undefined = start;
    while (cur !== undefined && !settled.has(cur.agentId)) {
      if (onPath.has(cur.agentId)) {
        const closer = path[path.length - 1]!;
        delete closer.parentAgentId;
        delete closer.toolUseId;
        delete closer.spawnUuid;
        break;
      }
      onPath.add(cur.agentId);
      path.push(cur);
      cur = cur.parentAgentId !== undefined ? byId.get(cur.parentAgentId) : undefined;
    }
    for (const r of path) settled.add(r.agentId);
  }
}

/** Plain text of a tool result's content blocks (for run-id matching). */
function resultText(tool: ToolInteraction): string {
  if (!tool.result) return '';
  return tool.result.content
    .map((b) => (b.type === 'text' ? b.text : JSON.stringify(b)))
    .join(' ');
}

/**
 * Build {@link SubagentRun}s from the loaded subagent sources, correlating each
 * to the `Agent`/`Task` tool call that spawned it — in the main thread, or in
 * another run's thread when a subagent spawned a subagent.
 *
 * Every run is assembled first so spawn points can be collected from all
 * threads (a parent may be listed after its child). Matching order: the exact
 * spawning id anywhere; else the task description (+ subagent type), which is
 * unique per call in practice — searched only in the parent the source names,
 * or, when it names none, only in the main thread, so a legacy nested run can
 * never be pulled under a same-named call in some other run. Matching is
 * intentionally strict: a subagent that can't be confidently matched is
 * returned WITHOUT a spawn link (the UI lists it separately) rather than risk
 * attaching it to the wrong call.
 */
export function buildSubagentRuns(
  mainThread: ThreadItem[],
  sources: SubagentSource[],
  opts: AssembleOptions = {},
): SubagentRun[] {
  const spawns: SpawnPoint[] = [];
  const workflowSpawns: WorkflowSpawn[] = [];
  collectSpawns(mainThread, undefined, spawns, workflowSpawns);

  const assembled = sources.map((src) => {
    const thread = assembleThread(src.events, opts);
    const toolCallCount = thread.reduce(
      (n, t) => n + t.blocks.filter((b) => b.kind === 'tool').length,
      0,
    );
    const totalTokens = subagentUsageTokens(src.events);
    return { src, thread, toolCallCount, totalTokens };
  });
  const runIds = new Set(sources.map((s) => s.agentId));
  for (const a of assembled) collectSpawns(a.thread, a.src.agentId, spawns, workflowSpawns);

  const runs: SubagentRun[] = [];
  for (const { src, thread, toolCallCount, totalTokens } of assembled) {
    // A named parent narrows description matching to that run's own calls. An
    // unknown or self-referential parent is ignored, not trusted.
    const parent =
      src.parentAgentId && src.parentAgentId !== src.agentId && runIds.has(src.parentAgentId)
        ? src.parentAgentId
        : undefined;
    const inScope = (s: { owner?: string }): boolean =>
      parent !== undefined ? s.owner === parent : s.owner === undefined;

    let match: { toolUseId: string; spawnUuid: string; owner?: string } | undefined;
    // The exact id wins — except in the run's own thread, and, when the source
    // names its parent, never inside some unrelated run (a colliding id would
    // otherwise re-parent the run to wherever that id happens to live).
    const directSpawn = src.toolUseId
      ? spawns.find(
          (s) =>
            !s.used &&
            s.toolUseId === src.toolUseId &&
            s.owner !== src.agentId &&
            (parent === undefined || s.owner === parent || s.owner === undefined),
        )
      : undefined;
    if (directSpawn) {
      directSpawn.used = true;
      match = directSpawn;
    } else if (src.workflowId) {
      // Workflow agents: link all of a run's agents to the Workflow tool call
      // whose result references the run id (a one-to-many spawn; not consumed).
      match = workflowSpawns.find(
        (w) => inScope(w) && w.resultText.includes(src.workflowId as string),
      );
    } else {
      // Agent/Task: match description (+ type), earliest unused. Require a
      // non-empty description so missing-meta agents never match by emptiness.
      const canMatch = src.description.length > 0;
      if (canMatch) {
        const sp =
          spawns.find(
            (s) =>
              !s.used &&
              inScope(s) &&
              s.description === src.description &&
              (!s.subagentType || !src.agentType || s.subagentType === src.agentType),
          ) ?? spawns.find((s) => !s.used && inScope(s) && s.description === src.description);
        if (sp) {
          sp.used = true;
          match = sp;
        }
      }

      // Missing or stale Claude metadata can leave description matching with
      // no candidate. Fall back only when the complete child prompt identifies
      // exactly one unused, type-compatible spawn.
      if (!match && src.prompt && src.prompt.trim().length > 0) {
        const promptMatches = spawns.filter(
          (s) =>
            !s.used &&
            inScope(s) &&
            s.prompt === src.prompt &&
            (!s.subagentType || !src.agentType || s.subagentType === src.agentType),
        );
        if (promptMatches.length === 1) {
          const [sp] = promptMatches;
          if (sp) {
            sp.used = true;
            match = sp;
          }
        }
      }
    }

    const run: SubagentRun = {
      agentId: src.agentId,
      agentType: src.agentType,
      description: src.description,
      messageCount: thread.length,
      toolCallCount,
      totalTokens,
      thread,
    };
    if (src.slug) run.slug = src.slug;
    if (match) {
      run.toolUseId = match.toolUseId;
      run.spawnUuid = match.spawnUuid;
      if (match.owner !== undefined) run.parentAgentId = match.owner;
    }
    runs.push(run);
  }

  breakParentCycles(runs);
  return runs;
}

/** Turn one event's content into display-ready thread blocks. */
function parseBlocks(
  event: UserEvent | AssistantEvent,
  resultsByToolUseId: Map<string, { isError: boolean; content: ContentBlock[] }>,
): ThreadBlock[] {
  const content = messageContent(event);

  // A plain-string message is a single text block.
  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'text', type: 'text', text: content }] : [];
  }
  // No usable content (no `message`, or a non-array `content`) — no blocks, which
  // the caller treats as "skip this turn" rather than crashing the whole session.
  if (content === null) return [];

  const blocks: ThreadBlock[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        blocks.push({ kind: 'text', type: 'text', text: block.text });
        break;
      case 'thinking':
        // The signature is deliberately dropped: it renders nothing and can be
        // a third of the response payload on big sessions.
        blocks.push({ kind: 'thinking', type: 'thinking', thinking: block.thinking });
        break;
      case 'tool_use': {
        const interaction: ToolInteraction = {
          kind: 'tool',
          id: block.id,
          name: block.name,
          input: block.input,
        };
        const result = resultsByToolUseId.get(block.id);
        if (result) interaction.result = result;
        blocks.push(interaction);
        break;
      }
      case 'tool_result':
        // Folded into the matching tool_use's ToolInteraction; skip here.
        break;
      default:
        // Unknown block types (e.g. 'image') are surfaced as attachments so
        // the frontend can decide how to render them.
        blocks.push({ kind: 'attachment', attachment: block });
        break;
    }
  }

  return blocks;
}
