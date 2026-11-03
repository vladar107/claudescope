import { describe, expect, it } from 'vitest';
import type { RawEvent } from '@claudescope/shared';
import { assembleThread, buildSubagentRuns } from '../src/data/parser.js';
import type { SubagentSource } from '../src/data/session-loader.js';
import { buildAgentMessages } from '../src/data/agent-messages.js';
import { claudeCodeConnector } from '../src/connectors/claude-code/claude-code.js';
import { codexConnector } from '../src/connectors/codex/codex.js';

const at = (s: number) => new Date(Date.parse('2026-01-01T01:00:00.000Z') + s * 1000).toISOString();

function row(type: 'user' | 'assistant', uuid: string, content: unknown, s: number): RawEvent {
  return {
    type,
    uuid,
    parentUuid: null,
    sessionId: 's',
    timestamp: at(s),
    cwd: '/x',
    isSidechain: false,
    message: { role: type, content },
  } as unknown as RawEvent;
}

const text = (t: string) => [{ type: 'text', text: t }];
const toolUse = (id: string, name: string, input: unknown = {}) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, content: string, is_error = false) => [
  { type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error } : {}) },
];

function source(agentId: string, events: RawEvent[], extra: Partial<SubagentSource> = {}): SubagentSource {
  return { agentId, agentType: 'general-purpose', description: agentId, events, ...extra };
}

function build(
  connectorId: string,
  main: RawEvent[],
  sources: SubagentSource[],
  activeAgentIds: string[] = [],
) {
  const thread = assembleThread(main);
  const runs = buildSubagentRuns(thread, sources);
  return buildAgentMessages({
    connectorId,
    thread,
    runs,
    signals: (connectorId === 'codex' ? codexConnector : claudeCodeConnector).interAgentSignals,
    activeAgentIds: new Set(activeAgentIds),
  });
}

const child = (id: string, last = 'report') => [
  row('user', `${id}-u`, text('do it'), 2),
  row('assistant', `${id}-a`, text(last), 10),
];

describe('buildAgentMessages', () => {
  it('derives spawn and result from a foreground call and its tool result', () => {
    const msgs = build(
      'claude-code',
      [
        row('user', 'u1', text('go'), 0),
        row('assistant', 'a1', [toolUse('t1', 'Agent', { description: 'dig', prompt: 'find it' })], 1),
        row('user', 'u2', toolResult('t1', 'found it'), 20),
      ],
      [source('r1', child('r1'), { description: 'dig', toolUseId: 't1' })],
    );
    expect(msgs.map((m) => m.kind)).toEqual(['spawn', 'result']);
    expect(msgs[0]).toMatchObject({ from: 'main', to: 'r1', text: 'find it', anchorUuid: 'a1' });
    expect(msgs[1]).toMatchObject({ from: 'r1', to: 'main', text: 'found it' });
  });

  it('takes a background result from the hand-back row, not the launch acknowledgement', () => {
    const msgs = build(
      'claude-code',
      [
        row('user', 'u1', text('go'), 0),
        row('assistant', 'a1', [toolUse('t1', 'Agent', { description: 'dig', prompt: 'p', run_in_background: 'true' })], 1),
        row('user', 'u2', toolResult('t1', 'Async agent launched successfully. agentId: r1'), 2),
        row('user', 'u3', text('<agent-message from="r1">[Subagent hand-back] the real report</agent-message>'), 30),
      ],
      [source('r1', child('r1'), { description: 'dig', toolUseId: 't1' })],
    );
    const result = msgs.filter((m) => m.kind === 'result');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ from: 'r1', to: 'main', text: 'the real report', anchorUuid: 'u3' });
  });

  it('ignores the launch acknowledgement and falls back to the run\'s last text', () => {
    const msgs = build(
      'claude-code',
      [
        row('user', 'u1', text('go'), 0),
        row('assistant', 'a1', [toolUse('t1', 'Agent', { description: 'dig', prompt: 'p', run_in_background: true })], 1),
        row('user', 'u2', toolResult('t1', 'Async agent launched successfully.'), 2),
      ],
      [source('r1', child('r1', 'final words'), { description: 'dig', toolUseId: 't1' })],
    );
    expect(msgs.find((m) => m.kind === 'result')).toMatchObject({ text: 'final words', anchorAgentId: 'r1' });
  });

  it('emits a task notification with its status, and drops ids that match no run', () => {
    const note = (id: string, status: string) =>
      `<task-notification><task-id>${id}</task-id><status>${status}</status><summary>S ${id}</summary></task-notification>`;
    const msgs = build(
      'claude-code',
      [
        row('user', 'u1', text('go'), 0),
        row('assistant', 'a1', [toolUse('t1', 'Agent', { description: 'dig', prompt: 'p' })], 1),
        row('user', 'u2', text(note('r1', 'failed')), 40),
        row('user', 'u3', text(note('bash9', 'completed')), 41),
      ],
      [source('r1', child('r1'), { description: 'dig', toolUseId: 't1' })],
      ['r1'],
    );
    const n = msgs.filter((m) => m.kind === 'notification');
    expect(n).toEqual([expect.objectContaining({ from: 'r1', to: 'main', status: 'failed', text: 'S r1' })]);
  });

  it('links a SendMessage from main to a finished run and flags a failed call', () => {
    const msgs = build(
      'claude-code',
      [
        row('user', 'u1', text('go'), 0),
        row('assistant', 'a1', [toolUse('t1', 'Agent', { description: 'dig', prompt: 'p' })], 1),
        row('user', 'u2', toolResult('t1', 'done'), 20),
        row('assistant', 'a2', [toolUse('t2', 'SendMessage', { to: 'r1', message: 'one more thing' })], 50),
        row('user', 'u3', toolResult('t2', 'no such agent', true), 51),
      ],
      [source('r1', child('r1'), { description: 'dig', toolUseId: 't1' })],
    );
    expect(msgs.find((m) => m.kind === 'message')).toMatchObject({
      from: 'main', to: 'r1', text: 'one more thing', status: 'error', anchorUuid: 'a2',
    });
  });

  it('attributes a nested spawn to the parent run, not main', () => {
    const p1 = [
      row('user', 'p1-u', text('go'), 2),
      row('assistant', 'p1-a', [toolUse('t2', 'Agent', { description: 'sub', prompt: 'deeper' })], 5),
      row('user', 'p1-r', toolResult('t2', 'sub done'), 12),
    ];
    const msgs = build(
      'claude-code',
      [
        row('user', 'u1', text('go'), 0),
        row('assistant', 'a1', [toolUse('t1', 'Agent', { description: 'top', prompt: 'p' })], 1),
        row('user', 'u2', toolResult('t1', 'top done'), 20),
      ],
      [
        source('p1', p1, { description: 'top', toolUseId: 't1' }),
        source('p2', child('p2'), { description: 'sub', toolUseId: 't2', parentAgentId: 'p1' }),
      ],
    );
    const spawn = msgs.find((m) => m.kind === 'spawn' && m.to === 'p2')!;
    expect(spawn).toMatchObject({ from: 'p1', anchorUuid: 'p1-a', anchorAgentId: 'p1', text: 'deeper' });
    expect(msgs.find((m) => m.kind === 'result' && m.from === 'p2')).toMatchObject({ to: 'p1' });
  });

  it('resolves a Codex target path to its run, and leaves wait_agent without one', () => {
    const msgs = build(
      'codex',
      [
        row('user', 'u1', text('go'), 0),
        row('assistant', 'a1', [toolUse('t1', 'Task', { description: '/root/worker', prompt: 'p' })], 1),
        row('user', 'u2', toolResult('t1', '{"task_name":"/root/worker"}'), 2),
        row('assistant', 'a2', [
          toolUse('t2', 'send_message', { target: '/root/worker', message: 'hi' }),
          toolUse('t3', 'followup_task', { target: 'worker', message: 'again' }),
          toolUse('t4', 'wait_agent', { timeout_ms: 1000 }),
          toolUse('t5', 'interrupt_agent', { target: '/root/ghost' }),
        ], 30),
      ],
      [source('thread-1', child('thread-1'), { description: '/root/worker', toolUseId: 't1' })],
    );
    expect(msgs.filter((m) => m.kind === 'message').map((m) => m.to)).toEqual(['thread-1', 'thread-1']);
    expect(msgs.find((m) => m.kind === 'wait')).not.toHaveProperty('to');
    expect(msgs.find((m) => m.kind === 'stop')).toBeUndefined();
    // The spawn output only acknowledges the launch, so the result is the run's own last text.
    expect(msgs.find((m) => m.kind === 'result')).toMatchObject({ text: 'report', anchorAgentId: 'thread-1' });
  });

  it('records only spawn and result for a spawn-result agent, and nothing for none', () => {
    const main = [
      row('user', 'u1', text('go'), 0),
      row('assistant', 'a1', [
        toolUse('t1', 'Task', { description: 'dig', prompt: 'p' }),
        toolUse('t2', 'SendMessage', { to: 'r1', message: 'hi' }),
      ], 1),
      row('user', 'u2', toolResult('t1', 'done'), 20),
    ];
    const sources = [source('r1', child('r1'), { description: 'dig', toolUseId: 't1' })];
    expect(build('pi', main, sources).map((m) => m.kind)).toEqual(['spawn', 'result']);
    expect(build('junie', main, sources)).toEqual([]);
  });

  it('strips the hand-back prefix when a newline follows the opening tag', () => {
    const msgs = build(
      'claude-code',
      [
        row('user', 'u1', text('go'), 0),
        row('assistant', 'a1', [toolUse('t1', 'Agent', { description: 'dig', prompt: 'p', run_in_background: true })], 1),
        row('user', 'u3', text('<agent-message from="r1">\n[Subagent hand-back] report</agent-message>'), 30),
      ],
      [source('r1', child('r1'), { description: 'dig', toolUseId: 't1' })],
    );
    expect(msgs.find((m) => m.kind === 'result')).toMatchObject({ text: 'report' });
  });

  it('keeps a stop on a run id and drops wait/stop on a shell task id', () => {
    const msgs = build(
      'claude-code',
      [
        row('user', 'u1', text('go'), 0),
        row('assistant', 'a1', [toolUse('t1', 'Agent', { description: 'dig', prompt: 'p' })], 1),
        row('user', 'u2', toolResult('t1', 'done'), 20),
        row('assistant', 'a2', [
          toolUse('t2', 'TaskStop', { task_id: 'r1' }),
          toolUse('t3', 'TaskStop', { task_id: 'b4k2m9x1q' }),
          toolUse('t4', 'TaskOutput', { task_id: 'b4k2m9x1q' }),
        ], 50),
      ],
      [source('r1', child('r1'), { description: 'dig', toolUseId: 't1' })],
    );
    expect(msgs.filter((m) => m.kind === 'stop' || m.kind === 'wait').map((m) => [m.kind, m.to])).toEqual([['stop', 'r1']]);
  });

  it('gives a foreground spawn no result until its own tool result arrives', () => {
    const msgs = build(
      'claude-code',
      [
        row('user', 'u1', text('go'), 0),
        row('assistant', 'a1', [toolUse('t1', 'Agent', { description: 'dig', prompt: 'p' })], 1),
      ],
      [source('r1', child('r1', 'Let me check X'), { description: 'dig', toolUseId: 't1' })],
    );
    expect(msgs.map((m) => m.kind)).toEqual(['spawn']);
  });

  it('emits one result per hand-back of a resumed run', () => {
    const msgs = build(
      'claude-code',
      [
        row('user', 'u1', text('go'), 0),
        row('assistant', 'a1', [toolUse('t1', 'Agent', { description: 'dig', prompt: 'p', run_in_background: true })], 1),
        row('user', 'u2', text('<agent-message from="r1">[Subagent hand-back] first</agent-message>'), 30),
        row('user', 'u3', text('<agent-message from="r1">[Subagent hand-back] second</agent-message>'), 60),
      ],
      [source('r1', child('r1'), { description: 'dig', toolUseId: 't1' })],
    );
    expect(msgs.filter((m) => m.kind === 'result').map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('never takes a Workflow call result as a run result', () => {
    const msgs = build(
      'claude-code',
      [
        row('user', 'u1', text('go'), 0),
        row('assistant', 'a1', [toolUse('t1', 'Workflow', {})], 1),
        row('user', 'u2', toolResult('t1', 'Workflow launched. Run ID: wf_abc'), 2),
      ],
      [source('w1', child('w1', 'built it'), { agentType: 'workflow-subagent', workflowId: 'wf_abc' })],
    );
    const result = msgs.filter((m) => m.kind === 'result');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: 'built it', anchorAgentId: 'w1' });
  });
});
