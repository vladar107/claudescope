/**
 * Pure logic for the in-session finder.
 *
 * Matches are computed from the transcript DATA (so collapsed content counts),
 * producing an ordered list of occurrences. The UI reveals and highlights only
 * the ACTIVE match's block at a time — never all of them — so a common word
 * can't expand the whole transcript at once.
 *
 * Text extraction is split from scanning: `buildSearchCorpus` walks the thread
 * once and pre-lowercases every block's text (tool inputs are JSON.stringify'd
 * exactly once), so each query change only runs cheap `indexOf` scans over
 * plain strings instead of re-serializing the whole transcript.
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

/** One searchable block, with its text extracted and lowercased exactly once. */
export interface CorpusEntry {
  /** `<turnUuid>:<blockIndex>` — also the DOM `data-block-id` of the block. */
  blockId: string;
  turnUuid: string;
  /** agentId if this block lives inside a subagent run. */
  subagentId?: string;
  /** The owning turn's role, so the role filter can apply at scan time. */
  role: string;
  /** Lowercased `blockText(block)`. */
  text: string;
}

function pushTurnEntries(
  turn: ThreadItem,
  subagentId: string | undefined,
  out: CorpusEntry[],
): void {
  turn.blocks.forEach((block, i) => {
    const text = blockText(block).toLowerCase();
    if (!text) return; // attachments etc. — nothing to search
    out.push({
      blockId: blockRevealId(turn.uuid, i),
      turnUuid: turn.uuid,
      ...(subagentId ? { subagentId } : {}),
      role: turn.role,
      text,
    });
  });
}

/**
 * Push one thread's entries in render order: each turn, and — right after a
 * tool call that spawned subagents — those runs' own threads, recursively, so
 * a subagent spawned by a subagent is searchable too. `nested` records every
 * run already walked, which both keeps the trailing orphan pass from repeating
 * one and bounds the recursion against a cyclic map.
 */
function pushThreadEntries(
  thread: ThreadItem[],
  subagentId: string | undefined,
  subagentsByToolUseId: Map<string, SubagentRun[]>,
  nested: Set<string>,
  out: CorpusEntry[],
): void {
  for (const turn of thread) {
    pushTurnEntries(turn, subagentId, out);
    for (const block of turn.blocks) {
      if (block.kind !== 'tool') continue;
      for (const run of subagentsByToolUseId.get(block.id) ?? []) {
        if (nested.has(run.agentId)) continue;
        nested.add(run.agentId);
        pushThreadEntries(run.thread, run.agentId, subagentsByToolUseId, nested, out);
      }
    }
  }
}

/**
 * Flatten the transcript into searchable entries, walking in render order: the
 * main thread with each spawned run nested at its tool call. Subagents that
 * never rendered nested (orphans) come last. Role filtering is NOT applied here
 * so the corpus survives filter changes.
 */
export function buildSearchCorpus(
  thread: ThreadItem[],
  subagents: SubagentRun[],
  subagentsByToolUseId: Map<string, SubagentRun[]>,
): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  const nested = new Set<string>();
  pushThreadEntries(thread, undefined, subagentsByToolUseId, nested, out);
  // Runs not reached from the main thread (unlinked, or nested under an
  // unlinked parent): walk parents before children so a nested run is
  // indexed inside its parent's panel, matching render order.
  for (const run of parentsFirst(subagents)) {
    if (nested.has(run.agentId)) continue;
    nested.add(run.agentId);
    pushThreadEntries(run.thread, run.agentId, subagentsByToolUseId, nested, out);
  }
  return out;
}

/** Stable sort by nesting depth (parent hops, capped) — payload order within a depth. */
function parentsFirst(runs: SubagentRun[]): SubagentRun[] {
  const byId = new Map(runs.map((r) => [r.agentId, r]));
  const depthOf = (run: SubagentRun): number => {
    let depth = 0;
    let cur: SubagentRun | undefined = run;
    while (cur?.parentAgentId !== undefined && cur.parentAgentId !== cur.agentId && depth < 32) {
      cur = byId.get(cur.parentAgentId);
      depth++;
    }
    return depth;
  };
  return runs.map((run, i) => ({ run, i, depth: depthOf(run) }))
    .sort((a, b) => a.depth - b.depth || a.i - b.i)
    .map((x) => x.run);
}

/** Scan a prebuilt corpus for a query — the only work that runs per keystroke. */
export function findMatches(
  corpus: CorpusEntry[],
  query: string,
  filter: RoleFilter,
): FinderMatch[] {
  const out: FinderMatch[] = [];
  const q = query.trim().toLowerCase();
  if (!q) return out;

  for (const entry of corpus) {
    if (!matchesRole(entry.role, filter)) continue;
    let from = 0;
    let occ = 0;
    let idx = entry.text.indexOf(q, from);
    while (idx !== -1) {
      out.push({
        blockId: entry.blockId,
        turnUuid: entry.turnUuid,
        ...(entry.subagentId ? { subagentId: entry.subagentId } : {}),
        occurrenceInBlock: occ,
      });
      occ += 1;
      from = idx + q.length;
      idx = entry.text.indexOf(q, from);
    }
  }
  return out;
}

/** One-shot corpus build + scan. Prefer caching the corpus via `buildSearchCorpus`. */
export function buildMatches(
  thread: ThreadItem[],
  subagents: SubagentRun[],
  subagentsByToolUseId: Map<string, SubagentRun[]>,
  query: string,
  filter: RoleFilter,
): FinderMatch[] {
  return findMatches(buildSearchCorpus(thread, subagents, subagentsByToolUseId), query, filter);
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
