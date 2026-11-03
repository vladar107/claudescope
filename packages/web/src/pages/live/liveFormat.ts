import type { LiveOpenTool, LiveRun, LiveState } from '@claudescope/shared';
import { toolInputFileName } from '../../components';

/** States that should be writing while they run; silence in them is the stuck signal. */
export const STALLABLE: LiveState[] = ['tool', 'working', 'subagents'];
export const RUNNING: LiveState[] = ['working', 'tool', 'subagents'];

export function stateLabel(state: LiveState, openTool?: LiveOpenTool): string {
  switch (state) {
    case 'idle':
      return 'Idle';
    case 'working':
      return 'Working';
    case 'tool':
      return openTool?.name ? `Running ${openTool.name}` : 'Running tool';
    case 'subagents':
      return 'Subagents running';
    case 'ended':
      return 'Ended';
    case 'unknown':
      return 'Unknown';
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** One-line summary of what a tool call is operating on: file name, else the first useful string field. */
export function toolSummary(tool: LiveOpenTool): string {
  const file = toolInputFileName(tool.input);
  if (file) return `${tool.name} ${file}`;
  const input = asRecord(tool.input);
  for (const key of ['command', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return `${tool.name} ${value.trim().split('\n')[0]}`;
    }
  }
  return tool.name;
}

export function ago(ms: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) return `${sec} s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} m ago`;
  const hr = Math.floor(min / 60);
  return hr < 24 ? `${hr} h ago` : `${Math.floor(hr / 24)} d ago`;
}

export function elapsed(ms: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} m ${sec % 60} s`;
  return `${Math.floor(min / 60)} h ${min % 60} m`;
}

export function runName(run: LiveRun): string {
  return run.description || run.agentType || 'subagent';
}
