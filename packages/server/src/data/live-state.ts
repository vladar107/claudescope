/**
 * Infers what a live session is doing from the tail of its assembled thread.
 *
 * There is no process introspection: every state is read off the transcript
 * (see docs/plans/0095-live-tab.md). The parser drops rows that carry only
 * tool results, so the tail is never a tool result — an unanswered call shows
 * up as a `ToolInteraction` with no `result`, and the rules below reason over
 * items and blocks instead.
 */

import type {
  LiveCompaction,
  LiveMinuteCount,
  LiveOpenTool,
  LiveRun,
  LiveState,
  SubagentRun,
  ThreadItem,
} from '@claudescope/shared';
import {
  hasCompactionSignal,
  hasInterruptSignal,
  hasLiveStateSignal,
  hasSessionEndSignal,
  hasToolErrorSignal,
  INTERRUPT_PREFIX,
} from './agent-capabilities.js';
import { SUBAGENT_TOOL_NAMES } from './parser.js';
import { isSyntheticTurn } from './title.js';

export interface LiveStateInput {
  connectorId: string;
  /** Main thread from `assembleThread()`. */
  thread: ThreadItem[];
  /** From `buildSubagentRuns()`. */
  runs: SubagentRun[];
  nowMs: number;
  /** Live window; a run counts as active only if its last item is within it. */
  windowMs: number;
  /** `SessionData.endedAt` — the declared end marker's timestamp. */
  endedAt?: string;
  /** `detail=full`: `lastText` keeps its newlines, and it and tool-input strings get {@link FULL_TEXT_CAP}. */
  full?: boolean;
}

export interface LiveStateResult {
  state: LiveState;
  /** Timestamp of the last main-thread item, epoch ms. */
  stateSinceMs?: number;
  /** Set only when state is `tool`; a `subagents` state drops it (the open call is a spawn). */
  openTool?: LiveOpenTool;
  subagents: { running: number; done: number };
  /** Last main-thread assistant text, collapsed (unless `full`) and capped; absent when none. */
  lastText?: string;
  /** Active runs first, then most recently written. */
  runs: LiveRun[];
  /** Failed main-thread tool calls; present only where the format records failures. */
  toolErrors?: number;
  /**
   * Per-minute item counts over the last ACTIVITY_KEEP_MS of `nowMs`. A cached
   * result is trimmed to the request's clock with {@link trimMinutes}, which
   * only drops old buckets; anything newer changes the fingerprint and
   * re-derives.
   */
  activity: LiveMinuteCount[];
  /** Main-thread compactions; present only where the agent records them. */
  compactions?: LiveCompaction[];
}

export const ACTIVITY_KEEP_MS = 60 * 60_000;
export const ACTIVITY_WINDOW_MS = 30 * 60_000;

function activityOf(threads: ThreadItem[][], nowMs: number): LiveMinuteCount[] {
  const floor = nowMs - ACTIVITY_KEEP_MS;
  const buckets = new Map<number, number>();
  for (const thread of threads) {
    for (const item of thread) {
      const ms = parseMs(item.timestamp);
      if (ms === undefined || ms < floor || ms > nowMs) continue;
      const minute = Math.floor(ms / 60_000);
      buckets.set(minute, (buckets.get(minute) ?? 0) + 1);
    }
  }
  return [...buckets].map(([minute, count]) => ({ minute, count })).sort((a, b) => a.minute - b.minute);
}

/** The buckets within the last `windowMs` of `nowMs`; the stored ones may predate it. */
export function trimMinutes<T extends { minute: number }>(buckets: T[], nowMs: number, windowMs: number): T[] {
  const floor = Math.floor((nowMs - windowMs) / 60_000);
  return buckets.filter((b) => b.minute >= floor);
}

function compactionsOf(thread: ThreadItem[]): LiveCompaction[] {
  const out: LiveCompaction[] = [];
  for (const item of thread) {
    if (!item.compaction) continue;
    const at = parseMs(item.timestamp);
    out.push({
      ...(at !== undefined ? { at } : {}),
      ...(item.compaction.preTokens !== undefined ? { preTokens: item.compaction.preTokens } : {}),
    });
  }
  return out;
}

/**
 * A run whose tail reads `working` but that has written nothing for this long
 * is treated as finished: some harnesses end a run with a hand-back tool call
 * (closed, so `working`) rather than final text. An open call is exempt — a
 * long command writes nothing while it runs.
 */
const RUN_QUIET_MS = 90_000;

const INPUT_STRING_CAP = 200;
const LAST_TEXT_CAP = 200;
const FULL_TEXT_CAP = 4000;
const INPUT_DEPTH_CAP = 4;

const capText = (text: string, cap: number): string => (text.length > cap ? `${text.slice(0, cap)}…` : text);

/** Copy of `value` with every string over `cap` truncated; never mutates it. */
function capInput(value: unknown, cap: number, depth = 0): unknown {
  if (typeof value === 'string') return capText(value, cap);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= INPUT_DEPTH_CAP) return '…';
  if (Array.isArray(value)) return value.map((v) => capInput(v, cap, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, capInput(v, cap, depth + 1)]),
  );
}

function parseMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

function itemText(item: ThreadItem): string {
  return item.blocks
    .map((b) => (b.kind === 'text' ? b.text : ''))
    .join('')
    .trim();
}

/** A user turn that is only local-command scaffolding: no model reply is coming.
 *  A `<task-notification>` is wrapper text too, but the model does answer it. */
function isLocalCommandTurn(text: string): boolean {
  if (/^<(task-notification|system-reminder)>/i.test(text)) return false;
  return isSyntheticTurn(text);
}

function lastAssistantText(thread: ThreadItem[], full: boolean): string | undefined {
  for (let i = thread.length - 1; i >= 0; i--) {
    const item = thread[i]!;
    if (item.role !== 'assistant') continue;
    for (let j = item.blocks.length - 1; j >= 0; j--) {
      const block = item.blocks[j]!;
      if (block.kind !== 'text') continue;
      const text = full ? block.text.trim() : block.text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      return capText(text, full ? FULL_TEXT_CAP : LAST_TEXT_CAP);
    }
  }
  return undefined;
}

function countToolErrors(thread: ThreadItem[]): number {
  let n = 0;
  for (const item of thread) {
    for (const block of item.blocks) if (block.kind === 'tool' && block.result?.isError) n++;
  }
  return n;
}

interface Tail {
  state: LiveState;
  openTool?: LiveOpenTool;
}

/** Tail rules for one thread, without subagents or end markers. */
function tailOf(connectorId: string, thread: ThreadItem[], inputCap: number): Tail {
  const last = thread[thread.length - 1];
  if (!last) return { state: 'unknown' };

  let lastUser = -1;
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i]!.role === 'user') {
      lastUser = i;
      break;
    }
  }
  const lastBlock = last.blocks[last.blocks.length - 1];
  if (last.role === 'assistant' && lastBlock?.kind === 'text') return { state: 'idle' };

  for (let i = thread.length - 1; i > lastUser; i--) {
    const item = thread[i]!;
    for (let j = item.blocks.length - 1; j >= 0; j--) {
      const block = item.blocks[j]!;
      if (block.kind !== 'tool' || block.result) continue;
      const sinceMs = parseMs(item.timestamp) ?? parseMs(last.timestamp);
      return {
        state: 'tool',
        openTool: {
          name: block.name,
          input: capInput(block.input, inputCap),
          ...(sinceMs !== undefined ? { sinceMs } : {}),
        },
      };
    }
  }

  if (last.role === 'user') {
    const text = itemText(last);
    if (hasInterruptSignal(connectorId) && text.startsWith(INTERRUPT_PREFIX)) {
      return { state: 'idle' };
    }
    if (isLocalCommandTurn(text)) return { state: 'idle' };
    return { state: 'working' };
  }
  const tailBlock = last.blocks[last.blocks.length - 1];
  return { state: tailBlock?.kind === 'text' ? 'idle' : 'working' };
}

export function deriveLiveState(input: LiveStateInput): LiveStateResult {
  const { connectorId, thread, runs, nowMs, windowMs, endedAt, full = false } = input;
  const inputCap = full ? FULL_TEXT_CAP : INPUT_STRING_CAP;

  const liveRuns: LiveRun[] = runs.map((run) => {
    const lastMs = parseMs(run.thread[run.thread.length - 1]?.timestamp);
    const age = lastMs === undefined ? Infinity : nowMs - lastMs;
    const tail = tailOf(connectorId, run.thread, inputCap);
    const active =
      age <= windowMs && (tail.state === 'tool' || (tail.state === 'working' && age <= RUN_QUIET_MS));
    return {
      agentId: run.agentId,
      agentType: run.agentType,
      description: run.description,
      active,
      state: tail.state,
      ...(tail.openTool ? { openTool: tail.openTool } : {}),
      ...(lastMs !== undefined ? { lastItemMs: lastMs } : {}),
      ...(run.parentAgentId ? { parentAgentId: run.parentAgentId } : {}),
    };
  });
  liveRuns.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastItemMs ?? 0) - (a.lastItemMs ?? 0));
  const running = liveRuns.filter((r) => r.active).length;
  const subagents = { running, done: liveRuns.length - running };
  const lastText = lastAssistantText(thread, full);
  const extras = {
    runs: liveRuns,
    ...(lastText !== undefined ? { lastText } : {}),
    ...(hasToolErrorSignal(connectorId) ? { toolErrors: countToolErrors(thread) } : {}),
    activity: activityOf([thread, ...runs.map((r) => r.thread)], nowMs),
    ...(hasCompactionSignal(connectorId) ? { compactions: compactionsOf(thread) } : {}),
  };

  const stateSinceMs = parseMs(thread[thread.length - 1]?.timestamp);
  const since = stateSinceMs !== undefined ? { stateSinceMs } : {};

  if (!hasLiveStateSignal(connectorId)) return { state: 'unknown', ...since, subagents, ...extras };

  const endedMs = hasSessionEndSignal(connectorId) ? parseMs(endedAt) : undefined;
  if (endedMs !== undefined && (stateSinceMs === undefined || stateSinceMs <= endedMs)) {
    return { state: 'ended', ...since, subagents, ...extras };
  }

  const tail = tailOf(connectorId, thread, inputCap);
  const openIsSpawn = tail.openTool !== undefined && SUBAGENT_TOOL_NAMES.has(tail.openTool.name);
  const overridden =
    running > 0 && tail.state !== 'unknown' && (tail.state !== 'tool' || openIsSpawn);
  if (overridden) return { state: 'subagents', ...since, subagents, ...extras };
  return {
    state: tail.state,
    ...since,
    ...(tail.openTool ? { openTool: tail.openTool } : {}),
    subagents,
    ...extras,
  };
}
