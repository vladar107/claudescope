/**
 * Windowing over an assembled session thread, for token-frugal consumers
 * (MCP tools, the CLI). Pure functions over the parsed thread — the route
 * applies them only when windowing params are present, so the web UI's
 * full-session path is untouched.
 */

import type {
  ContentBlock,
  SessionWindow,
  SubagentRun,
  ThreadBlock,
  ThreadItem,
} from '@claudescope/shared';
import { truncateText } from '@claudescope/shared';

export interface WindowParams {
  offset?: number;
  limit?: number;
  around?: string;
  radius?: number;
  tail?: number;
}

/** Default items on each side of an `around` anchor. */
export const DEFAULT_RADIUS = 10;

/**
 * Resolve the requested window to a [start, end) slice of `thread`.
 *
 * Precedence is `around` > `tail` > `offset`/`limit`.
 *
 * `around` centers the window on the item with that uuid. A uuid living inside
 * a subagent thread resolves to the main-thread turn that spawned the run
 * (`spawnUuid`); a uuid that can't be located at all falls back to the start of
 * the thread with `anchorFound: false` so the caller can tell the anchor missed.
 *
 * `tail` returns the last N items, clamped to the thread.
 */
export function resolveWindow(
  thread: ThreadItem[],
  subagents: SubagentRun[],
  params: WindowParams,
): SessionWindow {
  const total = thread.length;

  if (params.around !== undefined) {
    const radius = params.radius !== undefined && params.radius >= 0 ? params.radius : DEFAULT_RADIUS;
    let idx = thread.findIndex((t) => t.uuid === params.around);
    let anchorFound = idx >= 0;
    if (!anchorFound) {
      // The uuid may belong to a subagent turn — anchor on its spawn point.
      const run = subagents.find((r) => r.thread.some((t) => t.uuid === params.around));
      if (run?.spawnUuid) {
        idx = thread.findIndex((t) => t.uuid === run.spawnUuid);
        anchorFound = idx >= 0;
      }
    }
    const start = anchorFound ? Math.max(0, idx - radius) : 0;
    const end = anchorFound ? Math.min(total, idx + radius + 1) : Math.min(total, radius * 2 + 1);
    return { offset: start, limit: end - start, total, anchorFound };
  }

  if (params.tail !== undefined) {
    const start = Math.max(total - params.tail, 0);
    return { offset: start, limit: total - start, total };
  }

  const start = Math.min(Math.max(params.offset ?? 0, 0), total);
  const end = params.limit !== undefined && params.limit >= 0 ? Math.min(start + params.limit, total) : total;
  return { offset: start, limit: end - start, total };
}

/**
 * Subagent runs visible from a thread slice: those whose spawn turn
 * (`spawnUuid`) is inside it. Runs that never correlated to a spawn point have
 * no anchor to window against and are dropped from windowed responses.
 */
export function subagentsInWindow(slice: ThreadItem[], subagents: SubagentRun[]): SubagentRun[] {
  const uuids = new Set(slice.map((t) => t.uuid));
  return subagents.filter((r) => r.spawnUuid !== undefined && uuids.has(r.spawnUuid));
}

function truncateBlock(block: ThreadBlock, max: number): ThreadBlock {
  if (block.kind !== 'tool') return block;
  const input =
    block.input && typeof block.input === 'object' && !Array.isArray(block.input)
      ? Object.fromEntries(
          Object.entries(block.input as Record<string, unknown>).map(([k, v]) => [
            k,
            typeof v === 'string' ? truncateText(v, max) : v,
          ]),
        )
      : typeof block.input === 'string'
        ? truncateText(block.input, max)
        : block.input;
  const result = block.result
    ? {
        ...block.result,
        content: block.result.content.map(
          (b): ContentBlock => (b.type === 'text' ? { ...b, text: truncateText(b.text, max) } : b),
        ),
      }
    : block.result;
  return { ...block, input, result };
}

/** Cap tool input/result strings at `max` chars (copies; never mutates the parse). */
export function truncateToolChars(items: ThreadItem[], max: number): ThreadItem[] {
  if (max <= 0) return items;
  return items.map((item) => ({
    ...item,
    blocks: item.blocks.map((b) => truncateBlock(b, max)),
  }));
}
