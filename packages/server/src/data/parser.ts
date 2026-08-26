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
 *   - the `isSidechain` flag and usage/model/timestamp metadata.
 *
 * The pairing is done in a second pass: tool_use blocks are emitted inline in
 * the assistant turn where they occur, and the matching tool_result (which the
 * transcript records inside a later user message) is folded into that same
 * {@link ToolInteraction} rather than shown as a standalone block.
 */

import type {
  AssistantEvent,
  ContentBlock,
  MessageUsage,
  RawEvent,
  SubagentRun,
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
export function assembleThread(events: RawEvent[]): ThreadItem[] {
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

  for (const event of convo) {
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
    items.push(item);
  }

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

interface SpawnPoint {
  toolUseId: string;
  spawnUuid: string;
  description?: string;
  subagentType?: string;
  prompt?: string;
  used: boolean;
}

interface WorkflowSpawn {
  toolUseId: string;
  spawnUuid: string;
  /** Concatenated tool-result text — searched for the workflow run id. */
  resultText: string;
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
 * to the `Agent`/`Task` tool call in the main thread that spawned it.
 *
 * Correlation key is the task description (+ subagent type as a tiebreaker),
 * which is unique per call in practice. Matching is intentionally strict: a
 * subagent that can't be confidently matched is returned WITHOUT a spawn link
 * (the UI lists it separately) rather than risk attaching it to the wrong call.
 */
export function buildSubagentRuns(
  mainThread: ThreadItem[],
  sources: SubagentSource[],
): SubagentRun[] {
  const spawns: SpawnPoint[] = [];
  const workflowSpawns: WorkflowSpawn[] = [];
  for (const item of mainThread) {
    for (const block of item.blocks) {
      if (block.kind !== 'tool') continue;
      if (SUBAGENT_TOOL_NAMES.has(block.name)) {
        const input = (block.input ?? {}) as Record<string, unknown>;
        spawns.push({
          toolUseId: block.id,
          spawnUuid: item.uuid,
          description: typeof input.description === 'string' ? input.description : undefined,
          subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
          prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
          used: false,
        });
      } else if (block.name === 'Workflow') {
        workflowSpawns.push({
          toolUseId: block.id,
          spawnUuid: item.uuid,
          resultText: resultText(block),
        });
      }
    }
  }

  const runs: SubagentRun[] = [];
  for (const src of sources) {
    const thread = assembleThread(src.events);
    const toolCallCount = thread.reduce(
      (n, t) => n + t.blocks.filter((b) => b.kind === 'tool').length,
      0,
    );
    const totalTokens = thread.reduce((n, t) => n + usageTokens(t.usage), 0);

    let match: { toolUseId: string; spawnUuid: string } | undefined;
    const directSpawn = src.toolUseId
      ? spawns.find((s) => !s.used && s.toolUseId === src.toolUseId)
      : undefined;
    if (directSpawn) {
      directSpawn.used = true;
      match = directSpawn;
    } else if (src.workflowId) {
      // Workflow agents: link all of a run's agents to the Workflow tool call
      // whose result references the run id (a one-to-many spawn; not consumed).
      match = workflowSpawns.find((w) => w.resultText.includes(src.workflowId as string));
    } else {
      // Agent/Task: match description (+ type), earliest unused. Require a
      // non-empty description so missing-meta agents never match by emptiness.
      const canMatch = src.description.length > 0;
      if (canMatch) {
        const sp =
          spawns.find(
            (s) =>
              !s.used &&
              s.description === src.description &&
              (!s.subagentType || !src.agentType || s.subagentType === src.agentType),
          ) ?? spawns.find((s) => !s.used && s.description === src.description);
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
    }
    runs.push(run);
  }

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
