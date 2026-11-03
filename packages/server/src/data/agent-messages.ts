/**
 * Builds the ledger of messages between the agents of one session from its
 * assembled threads: spawns, reports, and — for agents whose format records
 * them — mid-run messages, waits, stops and status notices. Everything comes
 * from transcript records; nothing is inferred beyond matching a call's target
 * to a run.
 */

import type {
  AgentMessage,
  SubagentRun,
  ThreadItem,
  ToolInteraction,
} from '@claudescope/shared';
import type { InterAgentSignals } from '../connectors/types.js';
import { agentMessageSignal } from './agent-capabilities.js';
import { SUBAGENT_TOOL_NAMES } from './parser.js';

export interface AgentMessagesInput {
  connectorId: string;
  /** Main thread from `assembleThread()`. */
  thread: ThreadItem[];
  /** From `buildSubagentRuns()`. */
  runs: SubagentRun[];
  /** The connector's `interAgentSignals`; used only for `mid-run` agents. */
  signals?: InterAgentSignals;
  /** Runs `deriveLiveState` reports as active; a finished run's report is a result. */
  activeAgentIds?: ReadonlySet<string>;
}

const TEXT_CAP = 2000;
const MAIN = 'main';

interface Carrier {
  item: ThreadItem;
  owner: string;
  tool: ToolInteraction;
}

const cap = (s: string): string => (s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP)}…` : s);

function parseMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

function lastSegment(s: string): string {
  return (s.split('/').filter(Boolean).pop() ?? '').toLowerCase();
}

function toolResultText(tool: ToolInteraction): string {
  return (tool.result?.content ?? [])
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
    .trim();
}

function lastAssistantText(thread: ThreadItem[]): { item: ThreadItem; text: string } | undefined {
  for (let i = thread.length - 1; i >= 0; i--) {
    const item = thread[i]!;
    if (item.role !== 'assistant') continue;
    for (let j = item.blocks.length - 1; j >= 0; j--) {
      const b = item.blocks[j]!;
      if (b.kind === 'text' && b.text.trim()) return { item, text: b.text.trim() };
    }
  }
  return undefined;
}

export function buildAgentMessages(input: AgentMessagesInput): AgentMessage[] {
  const signal = agentMessageSignal(input.connectorId);
  if (signal === 'none') return [];
  const signals = signal === 'mid-run' ? input.signals : undefined;
  const { runs } = input;
  const active = input.activeAgentIds ?? new Set<string>();

  const threads: { owner: string; thread: ThreadItem[] }[] = [
    { owner: MAIN, thread: input.thread },
    ...runs.map((r) => ({ owner: r.agentId, thread: r.thread })),
  ];
  const carriers = new Map<string, Carrier>();
  for (const { owner, thread } of threads) {
    for (const item of thread) {
      for (const tool of item.blocks) {
        if (tool.kind === 'tool' && !carriers.has(`${owner}\0${tool.id}`)) {
          carriers.set(`${owner}\0${tool.id}`, { item, owner, tool });
        }
      }
    }
  }
  const anchor = (item: ThreadItem, owner: string) => ({
    anchorUuid: item.uuid,
    ...(owner !== MAIN ? { anchorAgentId: owner } : {}),
  });

  const runById = new Map(runs.map((r) => [r.agentId, r]));
  const resolveTarget = (target: string | undefined): string | undefined => {
    if (!target) return undefined;
    if (runById.has(target)) return target;
    const exact = runs.filter((r) => r.description === target || r.slug === target);
    if (exact.length === 1) return exact[0]!.agentId;
    const seg = lastSegment(target);
    if (!seg) return undefined;
    const loose = runs.filter((r) => lastSegment(r.description) === seg || lastSegment(r.slug ?? '') === seg);
    return loose.length === 1 ? loose[0]!.agentId : undefined;
  };

  // A notice about a run is only meaningful when its `from` names one: other
  // task ids (shell, monitor) are not agents of this session.
  const notices: { kind: 'result' | 'notification'; run: SubagentRun; owner: string; item: ThreadItem; text?: string; status?: string }[] = [];
  if (signals?.fromUserText) {
    for (const { owner, thread } of threads) {
      for (const item of thread) {
        if (item.role !== 'user') continue;
        for (const b of item.blocks) {
          if (b.kind !== 'text') continue;
          const n = signals.fromUserText(b.text);
          const run = n && runById.get(n.from);
          if (n && run && run.agentId !== owner) {
            notices.push({ kind: n.kind, run, owner, item, text: n.text, status: n.status });
          }
        }
      }
    }
  }

  const out: AgentMessage[] = [];

  for (const run of runs) {
    const parent = run.parentAgentId ?? MAIN;
    const spawn = run.toolUseId ? carriers.get(`${parent}\0${run.toolUseId}`) : undefined;
    if (spawn) {
      const args = (spawn.tool.input ?? {}) as Record<string, unknown>;
      const prompt = typeof args.prompt === 'string' && args.prompt ? args.prompt : undefined;
      const text = prompt ?? (typeof args.description === 'string' ? args.description : run.description);
      const at = parseMs(spawn.item.timestamp);
      out.push({
        kind: 'spawn',
        from: parent,
        to: run.agentId,
        ...(at !== undefined ? { at } : {}),
        ...(text ? { text: cap(text) } : {}),
        ...anchor(spawn.item, spawn.owner),
      });
    }

    const lastItem = run.thread[run.thread.length - 1];
    const lastAt = parseMs(lastItem?.timestamp);
    const handbacks = notices.filter((n) => n.kind === 'result' && n.run === run);
    for (const explicit of handbacks) {
      const at = parseMs(explicit.item.timestamp);
      out.push({
        kind: 'result',
        from: run.agentId,
        to: explicit.owner,
        ...(at !== undefined ? { at } : {}),
        ...(explicit.text ? { text: cap(explicit.text) } : {}),
        ...anchor(explicit.item, explicit.owner),
      });
    }
    if (handbacks.length > 0 || active.has(run.agentId)) continue;

    // A Workflow call is shared by all its runs and its result only acknowledges the launch.
    const resultCall = spawn && SUBAGENT_TOOL_NAMES.has(spawn.tool.name) ? spawn : undefined;
    const text = resultCall ? toolResultText(resultCall.tool) : '';
    const asyncLaunch = !!resultCall && !!signals?.isAsyncLaunch?.(resultCall.tool.input, text);
    if (resultCall && !asyncLaunch) {
      // Foreground: only the call's own result is the report; until it arrives there is none.
      if (!text) continue;
      const at = lastAt ?? parseMs(resultCall.item.timestamp);
      out.push({
        kind: 'result',
        from: run.agentId,
        to: parent,
        ...(at !== undefined ? { at } : {}),
        text: cap(text),
        ...(resultCall.tool.result?.isError ? { status: 'error' } : {}),
        ...anchor(resultCall.item, resultCall.owner),
      });
      continue;
    }
    const final = lastAssistantText(run.thread);
    if (final) {
      const at = parseMs(final.item.timestamp);
      out.push({
        kind: 'result',
        from: run.agentId,
        to: parent,
        ...(at !== undefined ? { at } : {}),
        text: cap(final.text),
        ...anchor(final.item, run.agentId),
      });
    }
  }

  if (signals) {
    for (const { owner, thread } of threads) {
      for (const item of thread) {
        for (const tool of item.blocks) {
          if (tool.kind !== 'tool' || SUBAGENT_TOOL_NAMES.has(tool.name)) continue;
          const call = signals.fromToolCall?.(tool.name, tool.input);
          if (!call) continue;
          const to = resolveTarget(call.target);
          // A task id that names no run is a shell task, not an agent.
          if (call.target && !to && (call.kind === 'wait' || call.kind === 'stop')) continue;
          const at = parseMs(item.timestamp);
          out.push({
            kind: call.kind,
            from: owner,
            ...(to ? { to } : {}),
            ...(at !== undefined ? { at } : {}),
            ...(call.text ? { text: cap(call.text) } : {}),
            ...(tool.result?.isError ? { status: 'error' } : {}),
            ...anchor(item, owner),
          });
        }
      }
    }
    for (const n of notices) {
      if (n.kind !== 'notification') continue;
      const at = parseMs(n.item.timestamp);
      out.push({
        kind: 'notification',
        from: n.run.agentId,
        to: n.owner,
        ...(at !== undefined ? { at } : {}),
        ...(n.text ? { text: cap(n.text) } : {}),
        ...(n.status ? { status: n.status } : {}),
        ...anchor(n.item, n.owner),
      });
    }
  }

  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      if (a.m.at === undefined || b.m.at === undefined) {
        if (a.m.at === b.m.at) return a.i - b.i;
        return a.m.at === undefined ? 1 : -1;
      }
      return a.m.at - b.m.at || a.i - b.i;
    })
    .map(({ m }) => m);
}
