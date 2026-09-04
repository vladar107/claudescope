import { describe, expect, it } from 'vitest';
import type { SubagentRun, ThreadItem } from '@claudescope/shared';
import { resolveWindow, subagentsInWindow, truncateToolChars } from '../src/data/window.js';

const item = (uuid: string, blocks: ThreadItem['blocks'] = []): ThreadItem => ({
  uuid,
  parentUuid: null,
  role: 'assistant',
  timestamp: '2026-01-01T00:00:00Z',
  isSidechain: false,
  blocks,
});

const run = (agentId: string, spawnUuid: string | undefined, threadUuids: string[]): SubagentRun => ({
  agentId,
  agentType: 'Explore',
  description: 'd',
  ...(spawnUuid ? { spawnUuid, toolUseId: `tu-${agentId}` } : {}),
  messageCount: threadUuids.length,
  toolCallCount: 0,
  totalTokens: 0,
  thread: threadUuids.map((u) => item(u)),
});

const thread = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5'].map((u) => item(u));

describe('resolveWindow', () => {
  it('clamps an around-window at the thread boundaries', () => {
    // Anchor at the very start: the left half of the radius has nowhere to go.
    expect(resolveWindow(thread, [], { around: 'm0', radius: 2 })).toEqual({
      offset: 0, limit: 3, total: 6, anchorFound: true,
    });
    // Anchor at the end: right half clamps.
    expect(resolveWindow(thread, [], { around: 'm5', radius: 2 })).toEqual({
      offset: 3, limit: 3, total: 6, anchorFound: true,
    });
    // Radius larger than the whole thread: the window is the whole thread.
    expect(resolveWindow(thread, [], { around: 'm2', radius: 100 })).toEqual({
      offset: 0, limit: 6, total: 6, anchorFound: true,
    });
  });

  it('resolves an around uuid living inside a subagent via its spawn turn', () => {
    const subs = [run('aaaa', 'm3', ['sa-1', 'sa-2'])];
    expect(resolveWindow(thread, subs, { around: 'sa-2', radius: 1 })).toEqual({
      offset: 2, limit: 3, total: 6, anchorFound: true,
    });
  });

  it('falls back to the thread start with anchorFound=false for an unknown uuid', () => {
    expect(resolveWindow(thread, [], { around: 'nope', radius: 1 })).toEqual({
      offset: 0, limit: 3, total: 6, anchorFound: false,
    });
  });

  it('tail clamps past the start and around still wins over it', () => {
    expect(resolveWindow(thread, [], { tail: 2 })).toEqual({ offset: 4, limit: 2, total: 6 });
    // More turns requested than exist: the whole thread, never a negative offset.
    expect(resolveWindow(thread, [], { tail: 99 })).toEqual({ offset: 0, limit: 6, total: 6 });
    // Degenerate but well-defined: an empty window pinned at the end.
    expect(resolveWindow(thread, [], { tail: 0 })).toEqual({ offset: 6, limit: 0, total: 6 });
    expect(resolveWindow(thread, [], { around: 'm1', radius: 0, tail: 3 })).toEqual({
      offset: 1, limit: 1, total: 6, anchorFound: true,
    });
  });

  it('anchors around a turn inside a nested run on the top-level ancestor’s spawn turn', () => {
    const subs = [
      run('in', 'm2', ['x']),
      { ...run('child', 'x', ['y']), parentAgentId: 'in' },
      { ...run('grandchild', 'y', ['z']), parentAgentId: 'child' },
    ];
    expect(resolveWindow(thread, subs, { around: 'z', radius: 0 })).toEqual({
      offset: 2, limit: 1, total: 6, anchorFound: true,
    });
    // A chain that never reaches the main thread (unlinked ancestor) is not an anchor.
    const loose = [{ ...run('child', 'x', ['y']), parentAgentId: 'ghost' }];
    expect(resolveWindow(thread, loose, { around: 'y', radius: 0 }).anchorFound).toBe(false);
  });

  it('around wins over offset/limit, and offset clamps past the end', () => {
    expect(resolveWindow(thread, [], { around: 'm4', radius: 0, offset: 0, limit: 99 })).toEqual({
      offset: 4, limit: 1, total: 6, anchorFound: true,
    });
    expect(resolveWindow(thread, [], { offset: 100, limit: 5 })).toEqual({
      offset: 6, limit: 0, total: 6,
    });
  });
});

describe('subagentsInWindow', () => {
  it('keeps only runs spawned inside the slice; uncorrelated runs are dropped', () => {
    const subs = [run('in', 'm2', ['x']), run('out', 'm5', ['y']), run('orphan', undefined, ['z'])];
    const slice = thread.slice(1, 4); // m1..m3
    expect(subagentsInWindow(slice, subs).map((r) => r.agentId)).toEqual(['in']);
  });

  it('carries nested runs with their ancestor, however deep, and drops them with it', () => {
    // grandchild → child → in (spawned at m2); their spawn turns are run
    // turns, never in the main slice.
    const subs = [
      run('in', 'm2', ['x']),
      { ...run('child', 'x', ['y']), parentAgentId: 'in' },
      { ...run('grandchild', 'y', ['z']), parentAgentId: 'child' },
      { ...run('elsewhere', 'q', ['w']), parentAgentId: 'out' },
      run('out', 'm5', ['q']),
    ];
    expect(subagentsInWindow(thread.slice(1, 4), subs).map((r) => r.agentId)).toEqual([
      'in', 'child', 'grandchild',
    ]);
    expect(subagentsInWindow(thread.slice(0, 1), subs)).toEqual([]);
  });
});

describe('truncateToolChars', () => {
  const long = 'y'.repeat(300);
  const items: ThreadItem[] = [
    item('t1', [
      {
        kind: 'tool',
        id: 'tu1',
        name: 'Bash',
        input: { command: long, timeout: 5000 },
        result: { isError: false, content: [{ type: 'text', text: long }] },
      },
      { kind: 'text', type: 'text', text: long },
    ]),
  ];

  it('caps string tool inputs and result text, leaves prose and non-strings alone', () => {
    const [out] = truncateToolChars(items, 10);
    const tool = out!.blocks[0] as Extract<ThreadItem['blocks'][number], { kind: 'tool' }>;
    const input = tool.input as Record<string, unknown>;
    expect(input.command).toBe('y'.repeat(10) + '… [truncated, 290 more chars]');
    expect(input.timeout).toBe(5000);
    const first = tool.result!.content[0]!;
    expect(first.type === 'text' && first.text).toContain('[truncated, 290 more chars]');
    const prose = out!.blocks[1]!;
    expect(prose.kind === 'text' && prose.text).toBe(long);
  });

  it('never mutates the source items', () => {
    truncateToolChars(items, 10);
    const tool = items[0]!.blocks[0] as Extract<ThreadItem['blocks'][number], { kind: 'tool' }>;
    expect((tool.input as Record<string, unknown>).command).toBe(long);
    const first = tool.result!.content[0]!;
    expect(first.type === 'text' && first.text).toBe(long);
  });
});
