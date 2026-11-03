import { describe, expect, it } from 'vitest';
import type { RawEvent } from '@claudescope/shared';
import { assembleThread, buildSubagentRuns } from '../src/data/parser.js';
import type { SubagentSource } from '../src/data/session-loader.js';
import { connectorsWithoutToolErrorSignal } from '../src/data/agent-capabilities.js';
import { deriveLiveState, trimMinutes, ACTIVITY_WINDOW_MS } from '../src/data/live-state.js';

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

  describe('runs, lastText and toolErrors', () => {
    const spawn = (id: string, desc: string) => toolUse(id, 'Task', { description: desc, subagent_type: 'Explore' });
    const src = (
      agentId: string,
      toolUseId: string,
      events: RawEvent[],
      extra: Partial<SubagentSource> = {},
    ): SubagentSource => ({ agentId, agentType: 'Explore', description: agentId, toolUseId, events, ...extra });
    const mainEvents = [
      row('user', 'u1', text('go'), at(5)),
      row('assistant', 'a1', [spawn('spawn1', 'parent')], at(4)),
    ];

    it('sorts active runs first then newest, and flags a nested run with its parent', () => {
      const r = derive(mainEvents, {
        sources: [
          src('done1', 'spawn1', [row('user', 'd1', text('x'), at(3)), row('assistant', 'd2', text('fin'), at(2))]),
          src('parent1', 'spawn1b', [
            row('user', 'p1', text('x'), at(2)),
            row('assistant', 'p2', [spawn('nested1', 'child')], at(1)),
            row('user', 'p3', toolResult('nested1'), at(1, 1)),
            row('assistant', 'p4', [toolUse('pt', 'Grep')], at(0, -5)),
          ]),
          src(
            'child1',
            'nested1',
            [row('user', 'c1', text('x'), at(1)), row('assistant', 'c2', [toolUse('ct', 'Bash')], at(0, -10))],
            { parentAgentId: 'parent1' },
          ),
        ],
      });
      expect(r.runs.map((x) => [x.agentId, x.active])).toEqual([
        ['parent1', true],
        ['child1', true],
        ['done1', false],
      ]);
      expect(r.runs.find((x) => x.agentId === 'child1')).toMatchObject({
        parentAgentId: 'parent1',
        state: 'tool',
        openTool: { name: 'Bash' },
      });
      expect(r.subagents).toEqual({ running: 2, done: 1 });
    });

    it('counts failed main-thread calls only where the agent records failures', () => {
      const failed = [
        row('user', 'u1', text('go'), at(5)),
        row('assistant', 'a1', [toolUse('t1', 'Bash')], at(4)),
        row('user', 'u2', [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }], at(3)),
        row('assistant', 'a2', text('done'), at(2)),
      ];
      expect(derive(failed).toolErrors).toBe(1);
      const without = connectorsWithoutToolErrorSignal()[0]!;
      expect(derive(failed, { connectorId: without }).toolErrors).toBeUndefined();
    });

    it('collapses whitespace and caps the last assistant text', () => {
      const r = derive([
        row('user', 'u1', text('go'), at(5)),
        row('assistant', 'a1', text(`first\n\n  line ${'y'.repeat(400)}`), at(4)),
      ]);
      expect(r.lastText!.startsWith('first line y')).toBe(true);
      expect(r.lastText!.length).toBe(201);
      expect(r.lastText!.endsWith('…')).toBe(true);
      expect(derive([row('user', 'u1', text('go'), at(5))]).lastText).toBeUndefined();
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

describe('activity and compactions', () => {
  const minute = (minutesAgo: number) => Math.floor((NOW - minutesAgo * 60_000) / 60_000);
  const spawn = toolUse('spawn1', 'Task', { description: 'dig', subagent_type: 'Explore' });
  const boundary = (uuid: string, ts: string, pre: number) =>
    ({
      type: 'system',
      subtype: 'compact_boundary',
      uuid,
      parentUuid: null,
      sessionId: 's',
      timestamp: ts,
      cwd: '/x',
      isSidechain: false,
      content: 'Conversation compacted',
      compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: 10 },
    }) as unknown as RawEvent;

  it('counts main and run items per minute, then trims to the request clock', () => {
    const r = derive(
      [
        row('user', 'u1', text('go'), at(40)),
        row('assistant', 'a1', [spawn], at(10, 5)),
        row('user', 'u2', text('again'), at(10, 20)),
      ],
      {
        sources: [
          {
            agentId: 'r1',
            agentType: 'Explore',
            description: 'dig',
            toolUseId: 'spawn1',
            events: [row('user', 'r1', text('x'), at(10, 30)), row('assistant', 'r2', text('y'), at(2))],
          },
        ],
      },
    );
    expect(r.activity).toEqual([
      { minute: minute(40), count: 1 },
      { minute: minute(10), count: 3 },
      { minute: minute(2), count: 1 },
    ]);
    expect(trimMinutes(r.activity, NOW, ACTIVITY_WINDOW_MS).map((b) => b.minute)).toEqual([minute(10), minute(2)]);
    expect(trimMinutes(r.activity, NOW + 21 * 60_000, ACTIVITY_WINDOW_MS).map((b) => b.minute)).toEqual([minute(2)]);
  });

  it('reports main-thread compactions only for agents that record them', () => {
    const events = [
      row('user', 'u1', text('go'), at(30)),
      boundary('b1', at(20), 90_000),
      row('assistant', 'a1', text('ok'), at(19)),
    ];
    expect(derive(events).compactions).toEqual([{ at: NOW - 19 * 60_000, preTokens: 90_000 }]);
    expect(derive(events, { connectorId: 'grok' }).compactions).toBeUndefined();
  });
});
