import { describe, expect, it } from 'vitest';
import type { RawEvent, SubagentRun, ThreadItem } from '@claudescope/shared';
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
  opts: { usage?: Record<string, number>; model?: string; isSidechain?: boolean; id?: string } = {},
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
      ...(opts.id ? { id: opts.id } : {}),
    },
  } as unknown as RawEvent;
}

/** A `compact_boundary` system row (Claude Code native / synthesized). */
function boundary(
  opts: { compactMetadata?: Record<string, unknown>; summary?: string } = {},
): RawEvent {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'sys',
    parentUuid: null,
    sessionId: 's',
    timestamp: ts(),
    cwd: '/x',
    ...opts,
  } as unknown as RawEvent;
}

/** A user turn flagged as the post-compaction summary (2025 format). */
function compactSummary(uuid: string, content: unknown): RawEvent {
  return { ...(user(uuid, content) as object), isCompactSummary: true } as RawEvent;
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
// Compaction stamping
// ---------------------------------------------------------------------------

describe('assembleThread compactions', () => {
  it('stamps the boundary metadata on the next conversational turn', () => {
    const thread = assembleThread([
      assistant('a1', [{ type: 'text', text: 'before' }]),
      boundary({ compactMetadata: { trigger: 'auto', preTokens: 152_000, postTokens: 21_000 } }),
      user('u1', 'carry on'),
    ]);
    expect(thread[0]?.compaction).toBeUndefined();
    expect(thread[1]?.compaction).toEqual({
      trigger: 'auto',
      preTokens: 152_000,
      postTokens: 21_000,
    });
  });

  it('carries the stamp past a tool_result-only turn onto the next rendered turn', () => {
    const thread = assembleThread([
      assistant('a1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
      boundary({ compactMetadata: { trigger: 'manual', preTokens: 90_000, postTokens: 8_000 } }),
      user('u1', [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }]),
      assistant('a2', [{ type: 'text', text: 'after' }]),
    ]);
    expect(thread.map((t) => t.uuid)).toEqual(['a1', 'a2']);
    expect(thread[1]?.compaction).toMatchObject({ trigger: 'manual', preTokens: 90_000 });
  });

  it('merges a boundary and its flagged summary turn into one stamp', () => {
    const thread = assembleThread([
      assistant('a1', [{ type: 'text', text: 'before' }]),
      boundary({ compactMetadata: { trigger: 'auto', preTokens: 150_000, postTokens: 12_000 } }),
      compactSummary('u1', 'This session is being continued from…'),
      assistant('a2', [{ type: 'text', text: 'after' }]),
    ]);
    expect(thread[1]?.compaction).toEqual({
      trigger: 'auto',
      preTokens: 150_000,
      postTokens: 12_000,
      isSummaryTurn: true,
    });
    // One compaction -> one stamp; the following turn stays clean.
    expect(thread[2]?.compaction).toBeUndefined();
  });

  it('merges them in either order (subagent files are timestamp-sorted, which can flip it)', () => {
    // On disk the summary turn can carry an EARLIER timestamp than its boundary,
    // so a sorted stream sees the summary first. Still one compaction.
    const thread = assembleThread([
      assistant('a1', [{ type: 'text', text: 'before' }]),
      compactSummary('u1', 'This session is being continued from…'),
      boundary({ compactMetadata: { trigger: 'manual', preTokens: 331_954, postTokens: 17_672 } }),
      assistant('a2', [{ type: 'text', text: 'after' }]),
    ]);
    expect(thread[1]?.compaction).toEqual({
      trigger: 'manual',
      preTokens: 331_954,
      postTokens: 17_672,
      isSummaryTurn: true,
    });
    expect(thread[2]?.compaction).toBeUndefined();
    // …but a boundary that follows a summary AND another turn is a second compaction.
    const two = assembleThread([
      compactSummary('u1', 'first summary'),
      assistant('a1', [{ type: 'text', text: 'work' }]),
      boundary({ compactMetadata: { trigger: 'auto' } }),
      assistant('a2', [{ type: 'text', text: 'after' }]),
    ]);
    expect(two.filter((t) => t.compaction)).toHaveLength(2);
  });

  it('stamps a flagged summary turn that has no boundary row (2025 format)', () => {
    const thread = assembleThread([
      assistant('a1', [{ type: 'text', text: 'before' }]),
      compactSummary('u1', 'Summary of the previous context'),
    ]);
    expect(thread[1]?.compaction).toEqual({ isSummaryTurn: true });
  });

  it('derives pre/post from the adjacent turns when the agent records neither', () => {
    const thread = assembleThread([
      assistant('a1', [{ type: 'text', text: 'before' }], {
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 5_000,
          cache_creation_input_tokens: 900,
        },
      }),
      boundary({ summary: 'We refactored the parser.' }),
      user('u1', 'continue'),
      assistant('a2', [{ type: 'text', text: 'after' }], {
        usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 1_000 },
      }),
    ]);
    expect(thread[1]?.compaction).toEqual({
      summary: 'We refactored the parser.',
      preTokens: 6_000,
      postTokens: 1_050,
    });
  });

  it('drops a boundary that nothing follows', () => {
    const thread = assembleThread([
      user('u1', 'hi'),
      assistant('a1', [{ type: 'text', text: 'bye' }]),
      boundary({ compactMetadata: { trigger: 'auto' } }),
    ]);
    expect(thread).toHaveLength(2);
    expect(thread.some((t) => t.compaction !== undefined)).toBe(false);
  });

  it('leaves ordinary turns without a compaction key', () => {
    const thread = assembleThread([
      user('u1', 'hi'),
      assistant('a1', [{ type: 'text', text: 'hello' }], {
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]);
    expect(thread.every((t) => !('compaction' in t))).toBe(true);
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
          input: {
            description: 'Explore X',
            subagent_type: 'Explore',
            prompt: 'Investigate the complete prompt\nincluding every detail.',
          },
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

  it('prefers an exact tool id over mismatched description and prompt metadata', () => {
    const [run] = buildSubagentRuns(mainThreadWithSpawns(), [
      source({
        agentId: 'a',
        agentType: 'Other',
        description: 'stale description',
        prompt: 'stale prompt',
        toolUseId: 'tu_agent',
      }),
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

  it('falls back to a unique exact full prompt when description metadata is stale', () => {
    const [run] = buildSubagentRuns(mainThreadWithSpawns(), [
      source({
        agentId: 'a',
        agentType: 'Explore',
        description: 'stale description',
        prompt: 'Investigate the complete prompt\nincluding every detail.',
      }),
    ]);
    expect(run?.toolUseId).toBe('tu_agent');
  });

  it('uses subagent type to narrow otherwise-identical prompt matches', () => {
    const main: ThreadItem[] = [
      {
        uuid: 'm1',
        parentUuid: null,
        role: 'assistant',
        timestamp: ts(),
        isSidechain: false,
        blocks: [
          {
            kind: 'tool',
            id: 'tu_explore',
            name: 'Task',
            input: { prompt: 'same prompt', subagent_type: 'Explore' },
          },
          {
            kind: 'tool',
            id: 'tu_plan',
            name: 'Task',
            input: { prompt: 'same prompt', subagent_type: 'Plan' },
          },
        ],
      },
    ];
    const [run] = buildSubagentRuns(main, [
      source({ agentId: 'a', agentType: 'Plan', prompt: 'same prompt' }),
    ]);
    expect(run?.toolUseId).toBe('tu_plan');
  });

  it('does NOT guess when an exact prompt matches multiple unused spawns', () => {
    const main: ThreadItem[] = [
      {
        uuid: 'm1',
        parentUuid: null,
        role: 'assistant',
        timestamp: ts(),
        isSidechain: false,
        blocks: [
          { kind: 'tool', id: 'tu1', name: 'Task', input: { prompt: 'same prompt' } },
          { kind: 'tool', id: 'tu2', name: 'Task', input: { prompt: 'same prompt' } },
        ],
      },
    ];
    const [run] = buildSubagentRuns(main, [
      source({ agentId: 'a', prompt: 'same prompt' }),
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

  it('elects the max-output row per message id instead of summing every block row', () => {
    // Claude Code writes one row per content block of an assistant message,
    // all sharing `message.id` and repeating the FULL usage object.
    const blockUsage = (output: number) => ({
      input_tokens: 100,
      output_tokens: output,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    });
    const events: RawEvent[] = [
      user('su', 'do it', true),
      assistant('sa1', [{ type: 'text', text: 'thinking' }], {
        usage: blockUsage(5),
        id: 'msg1',
        isSidechain: true,
      }),
      assistant('sa2', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], {
        usage: blockUsage(20),
        id: 'msg1',
        isSidechain: true,
      }),
      assistant('sa3', [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }], {
        usage: blockUsage(30),
        id: 'msg1',
        isSidechain: true,
      }),
      assistant('sa4', [{ type: 'text', text: 'done' }], {
        usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
        isSidechain: true,
      }),
    ];
    const [run] = buildSubagentRuns(mainThreadWithSpawns(), [
      source({ agentId: 'a', agentType: 'Explore', description: 'Explore X', events }),
    ]);
    // max-output row of msg1 (100 + 30 + 10 + 5 = 145) + the id-less row (7 + 3 + 1 + 2 = 13).
    expect(run?.totalTokens).toBe(158);
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

// ---------------------------------------------------------------------------
// Nested subagents (a subagent spawning a subagent)
// ---------------------------------------------------------------------------

/** A depth-1 run whose thread itself carries an Agent call (`tu_nested`). */
function spawningSource(agentId: string, description: string, nestedDescription: string): SubagentSource {
  return source({
    agentId,
    agentType: 'general-purpose',
    description,
    events: [
      user('su', 'do it', true),
      assistant(
        `${agentId}-spawn`,
        [
          {
            kind: 'tool',
            type: 'tool_use',
            id: 'tu_nested',
            name: 'Agent',
            input: { description: nestedDescription, subagent_type: 'general-purpose', prompt: 'nested prompt' },
          },
        ],
        { isSidechain: true },
      ),
    ],
  });
}

describe('buildSubagentRuns — nested subagents', () => {
  it('links a run by exact id to a call inside another run, whichever is listed first', () => {
    const runs = buildSubagentRuns(mainThreadWithSpawns(), [
      // Child listed BEFORE its parent: spawn points must come from every run.
      source({ agentId: 'child', description: 'nested probe', toolUseId: 'tu_nested', parentAgentId: 'parent' }),
      spawningSource('parent', 'Explore X', 'nested probe'),
    ]);
    const byId = new Map(runs.map((r) => [r.agentId, r]));
    expect(byId.get('parent')).toMatchObject({ toolUseId: 'tu_agent', spawnUuid: 'm1' });
    expect(byId.get('parent')?.parentAgentId).toBeUndefined();
    expect(byId.get('child')).toMatchObject({ toolUseId: 'tu_nested', spawnUuid: 'parent-spawn', parentAgentId: 'parent' });
  });

  it('a named parent narrows description matching to that run — the same-description trap', () => {
    // The nested call reuses the main thread's description. Without the parent
    // restriction the child would be attached to the main-thread call.
    const runs = buildSubagentRuns(mainThreadWithSpawns(), [
      spawningSource('parent', 'Explore X', 'Explore X'),
      source({ agentId: 'child', description: 'Explore X', parentAgentId: 'parent' }),
    ]);
    const byId = new Map(runs.map((r) => [r.agentId, r]));
    expect(byId.get('child')).toMatchObject({ toolUseId: 'tu_nested', parentAgentId: 'parent' });
    expect(byId.get('parent')).toMatchObject({ toolUseId: 'tu_agent' });
  });

  it('without parent metadata, description matching never leaves the main thread', () => {
    // Legacy child: no id, no parent. Its description only exists inside a
    // run's thread — it must stay unlinked rather than nest by guesswork.
    const runs = buildSubagentRuns(mainThreadWithSpawns(), [
      spawningSource('parent', 'Explore X', 'nested probe'),
      source({ agentId: 'legacy', description: 'nested probe' }),
    ]);
    const legacy = runs.find((r) => r.agentId === 'legacy');
    expect(legacy?.toolUseId).toBeUndefined();
    expect(legacy?.parentAgentId).toBeUndefined();
  });

  it('ignores an unknown or self-referential parent, and unlinks a parent cycle', () => {
    const unknown = buildSubagentRuns(mainThreadWithSpawns(), [
      source({ agentId: 'a', description: 'Explore X', parentAgentId: 'ghost' }),
    ]);
    // Falls back to main-thread matching, so the depth-1 link still lands.
    expect(unknown[0]).toMatchObject({ toolUseId: 'tu_agent' });
    expect(unknown[0]?.parentAgentId).toBeUndefined();

    const self = buildSubagentRuns(mainThreadWithSpawns(), [
      source({ agentId: 'a', description: 'Explore X', parentAgentId: 'a', toolUseId: 'tu_agent' }),
    ]);
    expect(self[0]).toMatchObject({ toolUseId: 'tu_agent' });
    expect(self[0]?.parentAgentId).toBeUndefined();

    // a's call is in b's thread and b's call is in a's thread. The cycle must
    // be broken (one link may legitimately survive) so a chain walker ends.
    const cycle = buildSubagentRuns([], [
      { ...spawningSource('a', 'A', 'B'), toolUseId: 'tu_nested', parentAgentId: 'b' },
      { ...spawningSource('b', 'B', 'A'), toolUseId: 'tu_nested', parentAgentId: 'a' },
    ]);
    const byId = new Map(cycle.map((r) => [r.agentId, r]));
    for (const r of cycle) {
      let cur: SubagentRun | undefined = r;
      let hops = 0;
      while (cur?.parentAgentId !== undefined && hops < 5) {
        cur = byId.get(cur.parentAgentId);
        hops++;
      }
      expect(hops).toBeLessThan(2);
    }
    expect(cycle.filter((r) => r.parentAgentId !== undefined).length).toBeLessThan(2);
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
