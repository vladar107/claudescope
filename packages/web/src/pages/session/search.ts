/**
 * Pure logic for the in-session finder.
 *
 * Matches are computed from the transcript DATA (so collapsed content counts),
 * producing an ordered list of occurrences. The UI reveals and highlights only
 * the ACTIVE match's block at a time — never all of them — so a common word
 * can't expand the whole transcript at once.
 */

import type { SubagentRun, ThreadBlock, ThreadItem } from '@claudescope/shared';

export type RoleFilter = 'all' | 'user' | 'assistant';

/** Stable id for a block within a turn: `<turnUuid>:<blockIndex>`. */
export function blockRevealId(turnUuid: string, blockIndex: number): string {
  return `${turnUuid}:${blockIndex}`;
}

/** The searchable source text of a single block. */
export function blockText(block: ThreadBlock): string {
  switch (block.kind) {
    case 'text':
      return block.text;
    case 'thinking':
      return block.thinking;
    case 'tool': {
      const parts = [block.name];
      try {
        parts.push(typeof block.input === 'string' ? block.input : JSON.stringify(block.input));
      } catch {
        /* ignore non-serializable input */
      }
      if (block.result) {
        for (const b of block.result.content) {
          if (b.type === 'text') parts.push(b.text);
        }
      }
      return parts.join(' ');
    }
    case 'attachment':
      return '';
  }
}

/** A single occurrence of the query somewhere in the transcript. */
export interface FinderMatch {
  /** `<turnUuid>:<blockIndex>` — also the DOM `data-block-id` of the block. */
  blockId: string;
  turnUuid: string;
  /** agentId if this match lives inside a subagent run. */
  subagentId?: string;
  /** 0-based index of this occurrence within its block's text. */
  occurrenceInBlock: number;
}

/** Blocks/subagents to force-open so a given match is visible. */
export interface RevealSets {
  blockIds: Set<string>;
  subagentIds: Set<string>;
}

const matchesRole = (role: string, filter: RoleFilter): boolean =>
  filter === 'all' || role === filter;

function pushTurnMatches(
  turn: ThreadItem,
  subagentId: string | undefined,
  q: string,
  filter: RoleFilter,
  out: FinderMatch[],
): void {
  if (!matchesRole(turn.role, filter)) return;
  turn.blocks.forEach((block, i) => {
    const text = blockText(block).toLowerCase();
    let from = 0;
    let occ = 0;
    let idx = text.indexOf(q, from);
    while (idx !== -1) {
      out.push({
        blockId: blockRevealId(turn.uuid, i),
        turnUuid: turn.uuid,
        ...(subagentId ? { subagentId } : {}),
        occurrenceInBlock: occ,
      });
      occ += 1;
      from = idx + q.length;
      idx = text.indexOf(q, from);
    }
  });
}

/**
 * Build the ordered match list, walking in render order: each main-thread turn,
 * and — right after a tool call that spawned subagents — that tool's subagent
 * runs (which render nested there). Orphan subagents come last.
 */
export function buildMatches(
  thread: ThreadItem[],
  subagents: SubagentRun[],
  subagentsByToolUseId: Map<string, SubagentRun[]>,
  query: string,
  filter: RoleFilter,
): FinderMatch[] {
  const out: FinderMatch[] = [];
  const q = query.trim().toLowerCase();
  if (!q) return out;

  const nested = new Set<string>();
  for (const turn of thread) {
    pushTurnMatches(turn, undefined, q, filter, out);
    for (const block of turn.blocks) {
      if (block.kind !== 'tool') continue;
      const runs = subagentsByToolUseId.get(block.id);
      if (!runs) continue;
      for (const run of runs) {
        nested.add(run.agentId);
        for (const t of run.thread) pushTurnMatches(t, run.agentId, q, filter, out);
      }
    }
  }
  for (const run of subagents) {
    if (nested.has(run.agentId)) continue;
    for (const t of run.thread) pushTurnMatches(t, run.agentId, q, filter, out);
  }
  return out;
}

/** The (minimal) reveal sets needed to make a single match visible. */
export function revealForMatch(match: FinderMatch | undefined): RevealSets {
  const blockIds = new Set<string>();
  const subagentIds = new Set<string>();
  if (match) {
    blockIds.add(match.blockId);
    if (match.subagentId) subagentIds.add(match.subagentId);
  }
  return { blockIds, subagentIds };
}
