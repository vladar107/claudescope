/**
 * How Claude Code records messages between agents: the `SendMessage`,
 * `TaskOutput` and `TaskStop` tools, `<task-notification>` user rows, and the
 * `<agent-message from="…">[Subagent hand-back] …` row a background subagent's
 * report arrives in.
 */

import type { InterAgentCall, InterAgentNotice, InterAgentSignals } from '../types.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function fromToolCall(name: string, input: unknown): InterAgentCall | null {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (name) {
    case 'SendMessage': {
      const text = str(args.message);
      return { kind: 'message', target: str(args.to), ...(text ? { text } : {}) };
    }
    case 'TaskOutput':
      return { kind: 'wait', target: str(args.task_id) };
    case 'TaskStop':
      return { kind: 'stop', target: str(args.task_id) };
    default:
      return null;
  }
}

function tag(text: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m?.[1]?.trim() || undefined;
}

const HANDBACK_PREFIX = /^\[Subagent hand-back\]\s*/;

function fromUserText(text: string): InterAgentNotice | null {
  const t = text.trimStart();
  if (t.startsWith('<task-notification>')) {
    const from = tag(t, 'task-id');
    if (!from) return null;
    const status = tag(t, 'status');
    const body = tag(t, 'summary') ?? tag(t, 'result');
    return { kind: 'notification', from, ...(status ? { status } : {}), ...(body ? { text: body } : {}) };
  }
  const m = /^<agent-message from="([^"]+)">/.exec(t);
  if (m) {
    const body = t
      .slice(m[0].length)
      .replace(/<\/agent-message>\s*$/, '')
      .trim()
      .replace(HANDBACK_PREFIX, '')
      .trim();
    return { kind: 'result', from: m[1]!, ...(body ? { text: body } : {}) };
  }
  return null;
}

function isAsyncLaunch(input: unknown, resultText: string): boolean {
  const flag = (input as { run_in_background?: unknown } | null)?.run_in_background;
  return flag === true || flag === 'true' || /^Async agent launched/i.test(resultText.trim());
}

export const claudeInterAgentSignals: InterAgentSignals = { fromToolCall, fromUserText, isAsyncLaunch };
