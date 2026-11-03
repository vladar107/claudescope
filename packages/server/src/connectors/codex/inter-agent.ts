/**
 * How Codex records messages between agents. Its tool calls pass through under
 * their raw names (only `spawn_agent` becomes a canonical `Task`); targets are
 * the child's task path (`/root/x`), a one-level name, or a bare name.
 */

import type { InterAgentCall, InterAgentSignals } from '../types.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function fromToolCall(name: string, input: unknown): InterAgentCall | null {
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (name) {
    case 'send_message':
    case 'followup_task': {
      const text = str(args.message);
      return { kind: 'message', target: str(args.target), ...(text ? { text } : {}) };
    }
    case 'wait_agent':
      return { kind: 'wait' };
    case 'interrupt_agent':
      return { kind: 'stop', target: str(args.target) };
    default:
      return null;
  }
}

/** `spawn_agent` answers at once with the child's path or id; the report comes later. */
function isAsyncLaunch(_input: unknown, resultText: string): boolean {
  try {
    const out = JSON.parse(resultText) as Record<string, unknown> | null;
    return !!out && typeof out === 'object' && ('task_name' in out || 'agent_id' in out);
  } catch {
    return false;
  }
}

export const codexInterAgentSignals: InterAgentSignals = { fromToolCall, isAsyncLaunch };
