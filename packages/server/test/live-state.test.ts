import { describe, expect, it } from 'vitest';
import type { RawEvent } from '@claudescope/shared';
import { assembleThread, buildSubagentRuns } from '../src/data/parser.js';
import type { SubagentSource } from '../src/data/session-loader.js';
import { deriveLiveState } from '../src/data/live-state.js';

const NOW = Date.parse('2026-01-01T01:00:00.000Z');
const WINDOW = 15 * 60_000;
const at = (minutesAgo: number, secs = 0) => new Date(NOW - minutesAgo * 60_000 + secs * 1000).toISOString();

function row(
  type: 'user' | 'assistant',
  uuid: string,
  content: unknown,
  timestamp: string,
  extra: { id?: string } = {},
): RawEvent {
  return {
    type,
    uuid,
    parentUuid: null,
    sessionId: 's',
    timestamp,
    cwd: '/x',
    isSidechain: false,
    message: { role: type, content, ...(extra.id ? { id: extra.id } : {}) },
  } as unknown as RawEvent;
}

const text = (t: string) => [{ type: 'text', text: t }];
const toolUse = (id: string, name: string, input: unknown = {}) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string) => [{ type: 'tool_result', tool_use_id: id, content: 'ok' }];

function derive(
  events: RawEvent[],
  opts: { connectorId?: string; sources?: SubagentSource[]; endedAt?: string } = {},
) {
  const thread = assembleThread(events);
  const runs = buildSubagentRuns(thread, opts.sources ?? []);
  return deriveLiveState({
    connectorId: opts.connectorId ?? 'claude-code',
    thread,
    runs,
    nowMs: NOW,
    windowMs: WINDOW,
    endedAt: opts.endedAt,
  });
}

describe('deriveLiveState', () => {
  it('reports an open tool as the last block, with the input capped', () => {
    const long = 'x'.repeat(500);
    const input = { command: long, nested: { deep: [long] } };
    const events = [
      row('user', 'u1', text('go'), at(5)),
      row('assistant', 'a1', [toolUse('t1', 'Bash', input)], at(4)),
    ];
    const r = derive(events);
    expect(r.state).toBe('tool');
    expect(r.openTool?.name).toBe('Bash');
    expect(r.openTool?.sinceMs).toBe(Date.parse(at(4)));
    const capped = r.openTool!.input as { command: string; nested: { deep: string[] } };
    expect(capped.command.length).toBeLessThan(250);
    expect(capped.nested.deep[0]!.length).toBeLessThan(250);
    expect(input.command).toHaveLength(500);
  });

  it('names an earlier open call when the last block of the turn is a closed parallel call', () => {
    const r = derive([
      row('user', 'u1', text('go'), at(5)),
      row('assistant', 'a1', [toolUse('t1', 'Bash', { command: 'slow' }), toolUse('t2', 'Read')], at(4)),
      row('user', 'u2', toolResult('t2'), at(3)),
    ]);
    expect(r.state).toBe('tool');
    expect(r.openTool?.name).toBe('Bash');
  });

  it('reads a closed tool as the last block as working', () => {
    const r = derive([
      row('user', 'u1', text('go'), at(5)),
      row('assistant', 'a1', [toolUse('t1', 'Bash')], at(4)),
      row('user', 'u2', toolResult('t1'), at(3)),
    ]);
    expect(r.state).toBe('working');
    expect(r.openTool).toBeUndefined();
  });

  it('reads trailing assistant text as idle', () => {
    const r = derive([row('user', 'u1', text('go'), at(5)), row('assistant', 'a1', text('done'), at(4))]);
    expect(r.state).toBe('idle');
    expect(r.stateSinceMs).toBe(Date.parse(at(4)));
  });

  it('treats the interrupt marker as idle only where the agent records it', () => {
    const events = [
      row('user', 'u1', text('go'), at(5)),
      row('assistant', 'a1', [toolUse('t1', 'Bash')], at(4)),
      row('user', 'u2', text('[Request interrupted by user for tool use]'), at(3)),
    ];
    expect(derive(events).state).toBe('idle');
    expect(derive(events, { connectorId: 'codex' }).state).toBe('working');
  });

  it('treats a local-command wrapper user row as idle, but a task notification as working', () => {
    const wrapper = [
      row('assistant', 'a1', text('hi'), at(5)),
      row('user', 'u1', text('<local-command-stdout>Compacted</local-command-stdout>'), at(4)),
    ];
    expect(derive(wrapper).state).toBe('idle');
    const notification = [
      row('assistant', 'a1', text('hi'), at(5)),
      row('user', 'u1', text('<task-notification>done</task-notification>'), at(4)),
    ];
    expect(derive(notification).state).toBe('working');
  });

  it('finds the open tool when one message is split across rows with tool_use last', () => {
    const r = derive([
      row('user', 'u1', text('go'), at(5)),
      row('assistant', 'a1', [{ type: 'thinking', thinking: '', signature: 'sig' }], at(4, 1), { id: 'msg_1' }),
      row('assistant', 'a2', text('Running it.'), at(4, 2), { id: 'msg_1' }),
      row('assistant', 'a3', [toolUse('t1', 'Bash', { command: 'ls' })], at(4, 3), { id: 'msg_1' }),
    ]);
    expect(r.state).toBe('tool');
    expect(r.openTool?.name).toBe('Bash');
  });

  it('reads an empty thread and a connector without a tail signal as unknown', () => {
    expect(derive([]).state).toBe('unknown');
    const events = [row('user', 'u1', text('go'), at(5)), row('assistant', 'a1', text('done'), at(4))];
    expect(derive(events, { connectorId: 'junie' }).state).toBe('unknown');
  });

  describe('subagents', () => {
    const spawnEvents = [
      row('user', 'u1', text('go'), at(5)),
      row('assistant', 'a1', [toolUse('spawn1', 'Task', { description: 'dig', subagent_type: 'Explore' })], at(4)),
      row('user', 'u2', toolResult('spawn1'), at(4, 1)),
      row('assistant', 'a2', text('Spawned it.'), at(4, 2)),
    ];
    const child = (lastMinutesAgo: number): SubagentSource => ({
      agentId: 'child1',
      agentType: 'Explore',
      description: 'dig',
      toolUseId: 'spawn1',
      events: [
        row('user', 'c1', text('dig'), at(lastMinutesAgo + 1)),
        row('assistant', 'c2', [toolUse('ct1', 'Grep')], at(lastMinutesAgo)),
      ],
    });

    it('counts a run whose tail is open and recent as running, overriding the main state', () => {
      const r = derive(spawnEvents, { sources: [child(1)] });
      expect(r.state).toBe('subagents');
      expect(r.subagents).toEqual({ running: 1, done: 0 });
    });

    it('counts a run last written outside the window as done, so the main state wins', () => {
      const r = derive(spawnEvents, { sources: [child(WINDOW / 60_000 + 5)] });
      expect(r.state).toBe('idle');
      expect(r.subagents).toEqual({ running: 0, done: 1 });
    });

    it('counts a run that ended on a closed hand-back call as done once it goes quiet', () => {
      const handedBack = (secsAgo: number): SubagentSource => ({
        ...child(1),
        events: [
          row('user', 'c1', text('dig'), at(5)),
          row('assistant', 'c2', [toolUse('ct1', 'SubagentHandback', { report: 'found it' })], at(0, -secsAgo - 1)),
          row('user', 'c3', toolResult('ct1'), at(0, -secsAgo)),
        ],
      });
      expect(derive(spawnEvents, { sources: [handedBack(10)] }).subagents).toEqual({ running: 1, done: 0 });
      const quiet = derive(spawnEvents, { sources: [handedBack(120)] });
      expect(quiet.subagents).toEqual({ running: 0, done: 1 });
      expect(quiet.state).toBe('idle');
    });

    it('keeps a non-spawn open tool as the main state', () => {
      const events = [...spawnEvents, row('assistant', 'a3', [toolUse('t9', 'Bash')], at(3))];
      const r = derive(events, { sources: [child(1)] });
      expect(r.state).toBe('tool');
      expect(r.subagents.running).toBe(1);
    });
  });

  it('reads a turn ending in final text as idle even with an earlier call that never got a result', () => {
    const events = [
      row('user', 'u1', text('go'), at(5)),
      row('assistant', 'a1', [toolUse('t1', 'Bash')], at(4)),
      row('assistant', 'a2', text('done anyway'), at(3)),
    ];
    expect(derive(events).state).toBe('idle');
  });

  describe('end marker', () => {
    const events = [row('user', 'u1', text('go'), at(5)), row('assistant', 'a1', text('done'), at(4))];

    it('is ended when no item is later than endedAt', () => {
      expect(derive(events, { connectorId: 'copilot', endedAt: at(3) }).state).toBe('ended');
    });

    it('ignores endedAt for a connector without a declared end signal', () => {
      expect(derive(events, { connectorId: 'claude-code', endedAt: at(3) }).state).not.toBe('ended');
    });

    it('is not ended when an item follows it', () => {
      expect(derive(events, { connectorId: 'copilot', endedAt: at(4, -1 * 60 - 30) }).state).not.toBe('ended');
    });
  });
});
