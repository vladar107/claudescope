import { describe, expect, it } from 'vitest';
import type { RawEvent, ThreadItem } from '@claudescope/shared';
import { assembleThread, buildSubagentRuns } from '../src/data/parser.js';
import type { SubagentSource } from '../src/data/session-loader.js';

// ---------------------------------------------------------------------------
// Minimal raw-event factories (only the fields the parser reads).
// ---------------------------------------------------------------------------

let clock = 0;
function ts(): string {
  clock += 1;
  return `2026-01-01T00:00:${String(clock).padStart(2, '0')}.000Z`;
}

function user(uuid: string, content: unknown, isSidechain = false): RawEvent {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId: 's',
    timestamp: ts(),
    cwd: '/x',
    isSidechain,
    message: { role: 'user', content },
  } as unknown as RawEvent;
}

function assistant(
  uuid: string,
  content: unknown,
  opts: { usage?: Record<string, number>; model?: string; isSidechain?: boolean } = {},
): RawEvent {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    sessionId: 's',
    timestamp: ts(),
    cwd: '/x',
    isSidechain: opts.isSidechain ?? false,
    message: {
      role: 'assistant',
      content,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.usage ? { usage: opts.usage } : {}),
    },
  } as unknown as RawEvent;
}

describe('assembleThread', () => {
  it('renders plain user + assistant text turns (happy path)', () => {
    const thread = assembleThread([
      user('u1', 'hello'),
      assistant('a1', [{ type: 'text', text: 'hi there' }], { model: 'claude-opus-4-8' }),
    ]);
    expect(thread).toHaveLength(2);
    expect(thread[0]).toMatchObject({ role: 'user', blocks: [{ kind: 'text', text: 'hello' }] });
    expect(thread[1]?.model).toBe('claude-opus-4-8');
    expect(thread[1]?.blocks[0]).toMatchObject({ kind: 'text', text: 'hi there' });
  });

  it('treats a string message.content as a single text block', () => {
    const [item] = assembleThread([user('u1', 'just a string')]);
    expect(item?.blocks).toEqual([{ kind: 'text', type: 'text', text: 'just a string' }]);
  });

  it('pairs tool_use with a tool_result from a later turn and drops the result-only turn', () => {
    const thread = assembleThread([
      assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
      user('u1', [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt' }]),
    ]);
    // The result-only user turn produces no standalone blocks -> dropped.
    expect(thread).toHaveLength(1);
    const tool = thread[0]?.blocks[0];
    expect(tool).toMatchObject({ kind: 'tool', id: 't1', name: 'Bash' });
    expect((tool as { result?: unknown }).result).toEqual({
      isError: false,
      content: [{ type: 'text', text: 'file.txt' }],
    });
  });

  it('normalizes a block-array tool_result and preserves is_error', () => {
    const thread = assembleThread([
      assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
      user('u1', [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          is_error: true,
          content: [{ type: 'text', text: 'boom' }],
        },
      ]),
    ]);
    const tool = thread[0]?.blocks[0] as { result?: { isError: boolean; content: unknown[] } };
    expect(tool.result?.isError).toBe(true);
    expect(tool.result?.content).toEqual([{ type: 'text', text: 'boom' }]);
  });

  it('leaves a tool_use unresolved when no result arrives', () => {
    const thread = assembleThread([
      assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
    ]);
    expect((thread[0]?.blocks[0] as { result?: unknown }).result).toBeUndefined();
  });

  it('keeps thinking blocks and surfaces unknown block types as attachments', () => {
    const thread = assembleThread([
      assistant('a1', [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'image', source: { type: 'url', url: 'http://x/y.png' } },
      ]),
    ]);
    const kinds = thread[0]?.blocks.map((b) => b.kind);
    expect(kinds).toEqual(['thinking', 'attachment']);
  });

  it('preserves isSidechain and usage metadata', () => {
    const [item] = assembleThread([
      assistant('a1', [{ type: 'text', text: 'x' }], {
        usage: { input_tokens: 10, output_tokens: 5 },
        isSidechain: true,
      }),
    ]);
    expect(item?.isSidechain).toBe(true);
    expect(item?.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });

  it('ignores non-conversational events', () => {
    const thread = assembleThread([
      { type: 'ai-title', sessionId: 's', aiTitle: 'T' } as unknown as RawEvent,
      user('u1', 'hi'),
    ]);
    expect(thread).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// buildSubagentRuns
// ---------------------------------------------------------------------------

/** A main thread with an Agent and a Workflow tool call. */
function mainThreadWithSpawns(): ThreadItem[] {
  return [
    {
      uuid: 'm1',
      parentUuid: null,
      role: 'assistant',
      timestamp: ts(),
      isSidechain: false,
      blocks: [
        {
          kind: 'tool',
          id: 'tu_agent',
          name: 'Agent',
          input: { description: 'Explore X', subagent_type: 'Explore' },
        },
        {
          kind: 'tool',
          id: 'tu_wf',
          name: 'Workflow',
          input: {},
          result: { isError: false, content: [{ type: 'text', text: 'Run ID: wf_abc — go' }] },
        },
      ],
    },
  ];
}

function source(over: Partial<SubagentSource>): SubagentSource {
  return {
    agentId: 'id',
    agentType: '',
    description: '',
    events: [
      user('su', 'do it', true),
      assistant('sa', [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }], {
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
        isSidechain: true,
      }),
    ],
    ...over,
  };
}

describe('buildSubagentRuns', () => {
  it('links an Agent run by description + subagent_type', () => {
    const [run] = buildSubagentRuns(mainThreadWithSpawns(), [
      source({ agentId: 'a', agentType: 'Explore', description: 'Explore X' }),
    ]);
    expect(run?.toolUseId).toBe('tu_agent');
    expect(run?.spawnUuid).toBe('m1');
  });

  it('falls back to description-only when type differs', () => {
    const [run] = buildSubagentRuns(mainThreadWithSpawns(), [
      source({ agentId: 'a', agentType: 'general-purpose', description: 'Explore X' }),
    ]);
    expect(run?.toolUseId).toBe('tu_agent');
  });

  it('does NOT link a run whose description is empty (missing meta.json)', () => {
    const [run] = buildSubagentRuns(mainThreadWithSpawns(), [
      source({ agentId: 'a', agentType: 'Explore', description: '' }),
    ]);
    expect(run?.toolUseId).toBeUndefined();
  });

  it('does NOT link a run whose description matches nothing', () => {
    const [run] = buildSubagentRuns(mainThreadWithSpawns(), [
      source({ agentId: 'a', description: 'totally different' }),
    ]);
    expect(run?.toolUseId).toBeUndefined();
  });

  it('links many workflow agents to the one Workflow call via run id (one-to-many)', () => {
    const runs = buildSubagentRuns(mainThreadWithSpawns(), [
      source({ agentId: 'w1', agentType: 'workflow-subagent', description: 'Build A', workflowId: 'wf_abc' }),
      source({ agentId: 'w2', agentType: 'workflow-subagent', description: 'Build B', workflowId: 'wf_abc' }),
    ]);
    expect(runs.map((r) => r.toolUseId)).toEqual(['tu_wf', 'tu_wf']);
  });

  it('leaves a workflow agent unlinked when its run id is absent from results', () => {
    const [run] = buildSubagentRuns(mainThreadWithSpawns(), [
      source({ agentId: 'w', workflowId: 'wf_missing' }),
    ]);
    expect(run?.toolUseId).toBeUndefined();
  });

  it('computes toolCallCount and totalTokens from the subagent thread', () => {
    const [run] = buildSubagentRuns(mainThreadWithSpawns(), [
      source({ agentId: 'a', agentType: 'Explore', description: 'Explore X' }),
    ]);
    expect(run?.toolCallCount).toBe(1);
    expect(run?.totalTokens).toBe(17); // 10 + 5 + 2
    expect(run?.messageCount).toBe(2);
  });

  it('consumes each Agent spawn at most once for duplicate descriptions', () => {
    const main: ThreadItem[] = [
      {
        uuid: 'm1',
        parentUuid: null,
        role: 'assistant',
        timestamp: ts(),
        isSidechain: false,
        blocks: [
          { kind: 'tool', id: 'tu1', name: 'Task', input: { description: 'dup' } },
          { kind: 'tool', id: 'tu2', name: 'Task', input: { description: 'dup' } },
        ],
      },
    ];
    const runs = buildSubagentRuns(main, [
      source({ agentId: 'r1', description: 'dup' }),
      source({ agentId: 'r2', description: 'dup' }),
    ]);
    expect(new Set(runs.map((r) => r.toolUseId))).toEqual(new Set(['tu1', 'tu2']));
  });
});

describe('malformed transcript rows', () => {
  // Transcripts are read with `JSON.parse(...) as RawEvent` — no shape check —
  // and the indexer's SQL explicitly tolerates a user/assistant row with no
  // `message` (`WHEN message IS NULL THEN …`). Such rows therefore reach the
  // assembler, where dereferencing `message.content` used to throw and 500 the
  // whole session-detail route: the session listed in Browse but could not be
  // opened. 0 of 5,687 real rows hit this, so it is a robustness guard, not a
  // live bug — but one bad line should never cost a whole transcript.
  const raw = (o: unknown): RawEvent[] => [o] as unknown as RawEvent[];

  it('skips a conversational row with no message object', () => {
    expect(assembleThread(raw({ type: 'user', uuid: 'a', parentUuid: null }))).toEqual([]);
  });

  it.each([null, 42, 'x' as unknown, { blocks: [] }])(
    'skips a row whose message.content is %s',
    (content) => {
      const events = raw({
        type: 'assistant',
        uuid: 'b',
        parentUuid: null,
        message: { role: 'assistant', content },
      });
      // A string IS valid content, so only that one produces a turn.
      expect(assembleThread(events)).toHaveLength(typeof content === 'string' ? 1 : 0);
    },
  );

  it('keeps the surrounding good turns when one row is malformed', () => {
    const events = raw({ type: 'user', uuid: 'bad', parentUuid: null }).concat(
      [
        { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hello' } },
        {
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        },
      ] as unknown as RawEvent[],
    );
    expect(assembleThread(events).map((t) => t.uuid)).toEqual(['u1', 'a1']);
  });

  it('still pairs a tool_result that arrives alongside a malformed row', () => {
    const events = [
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: null,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      },
      { type: 'user', uuid: 'bad', parentUuid: 'a1' },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
      },
    ] as unknown as RawEvent[];
    const thread = assembleThread(events);
    const tool = thread[0]?.blocks[0];
    expect(tool?.kind).toBe('tool');
    expect(tool?.kind === 'tool' && tool.result?.content).toEqual([{ type: 'text', text: 'done' }]);
  });
});
