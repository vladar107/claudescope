import { describe, expect, it } from 'vitest';
import type { SubagentRun, ThreadItem } from '@claudescope/shared';
import { blockText, buildMatches, revealForMatch } from '../src/pages/session/search.js';

function turn(uuid: string, role: 'user' | 'assistant', blocks: ThreadItem['blocks']): ThreadItem {
  return { uuid, parentUuid: null, role, timestamp: '2026-01-01T00:00:00Z', isSidechain: false, blocks };
}
const noMap = new Map<string, SubagentRun[]>();

describe('blockText', () => {
  it('extracts text, thinking, and tool (name + input + result) content', () => {
    expect(blockText({ kind: 'text', type: 'text', text: 'hi' })).toBe('hi');
    expect(blockText({ kind: 'thinking', type: 'thinking', thinking: 'pondering' })).toBe('pondering');
    const tool = blockText({
      kind: 'tool',
      id: 't',
      name: 'Bash',
      input: { command: 'ls -la' },
      result: { isError: false, content: [{ type: 'text', text: 'file.txt' }] },
    });
    expect(tool).toContain('Bash');
    expect(tool).toContain('ls -la');
    expect(tool).toContain('file.txt');
  });

  it('returns empty string for attachments', () => {
    expect(blockText({ kind: 'attachment', attachment: { type: 'image' } })).toBe('');
  });
});

describe('buildMatches', () => {
  const thread: ThreadItem[] = [
    turn('t1', 'assistant', [
      { kind: 'text', type: 'text', text: 'a needle and another needle' }, // 2 occurrences
      { kind: 'thinking', type: 'thinking', thinking: 'the needle is here' }, // 1
    ]),
    turn('t2', 'user', [{ kind: 'text', type: 'text', text: 'no match here' }]),
  ];
  const subagents: SubagentRun[] = [
    {
      agentId: 's1',
      agentType: 'Explore',
      description: 'd',
      messageCount: 1,
      toolCallCount: 0,
      totalTokens: 0,
      thread: [turn('su1', 'assistant', [{ kind: 'text', type: 'text', text: 'needle in subagent' }])],
    },
  ];

  it('returns one match per occurrence, in order, with per-block occurrence index', () => {
    const m = buildMatches(thread, [], noMap, 'needle', 'all');
    expect(m).toHaveLength(3);
    expect(m[0]).toMatchObject({ blockId: 't1:0', occurrenceInBlock: 0 });
    expect(m[1]).toMatchObject({ blockId: 't1:0', occurrenceInBlock: 1 });
    expect(m[2]).toMatchObject({ blockId: 't1:1', occurrenceInBlock: 0 });
  });

  it('includes subagent matches tagged with the subagent id (orphan run)', () => {
    const m = buildMatches(thread, subagents, noMap, 'needle', 'all');
    const sub = m.find((x) => x.subagentId === 's1');
    expect(sub).toMatchObject({ blockId: 'su1:0', subagentId: 's1' });
  });

  it('respects the role filter', () => {
    expect(buildMatches(thread, subagents, noMap, 'needle', 'user')).toHaveLength(0);
    expect(buildMatches(thread, subagents, noMap, 'needle', 'assistant').length).toBe(4);
  });

  it('is empty for a blank query and case-insensitive otherwise', () => {
    expect(buildMatches(thread, [], noMap, '  ', 'all')).toHaveLength(0);
    expect(buildMatches(thread, [], noMap, 'NEEDLE', 'all')).toHaveLength(3);
  });
});

describe('revealForMatch', () => {
  it('reveals only the match block (and its subagent when nested)', () => {
    const r = revealForMatch({ blockId: 'su1:2', turnUuid: 'su1', subagentId: 's1', occurrenceInBlock: 0 });
    expect([...r.blockIds]).toEqual(['su1:2']);
    expect([...r.subagentIds]).toEqual(['s1']);
  });

  it('reveals nothing for no match', () => {
    const r = revealForMatch(undefined);
    expect(r.blockIds.size).toBe(0);
    expect(r.subagentIds.size).toBe(0);
  });
});
