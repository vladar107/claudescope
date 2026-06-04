import { describe, expect, it } from 'vitest';
import type { SubagentRun, ThreadItem } from '@claudescope/shared';
import { buildChangeset, fileStats } from '../src/pages/session/changeset.js';

function turn(blocks: ThreadItem['blocks']): ThreadItem {
  return { uuid: 'u', parentUuid: null, role: 'assistant', timestamp: 't', isSidechain: false, blocks };
}
const tool = (name: string, input: unknown) => ({ kind: 'tool' as const, id: name, name, input });

describe('buildChangeset', () => {
  it('groups Edit/MultiEdit/Write by file (cheap, no diffing) in first-seen order', () => {
    const thread = [
      turn([tool('Edit', { file_path: 'src/a.ts', old_string: 'one\ntwo', new_string: 'one\nTWO\nthree' })]),
      turn([tool('Write', { file_path: 'src/b.ts', content: 'x\ny' })]),
      turn([
        tool('MultiEdit', {
          file_path: 'src/a.ts',
          edits: [{ old_string: 'k', new_string: 'K' }],
        }),
      ]),
    ];
    const changes = buildChangeset(thread, []);
    // a.ts touched twice (Edit + MultiEdit), b.ts once; first-seen order.
    expect(changes.map((c) => c.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(changes[0]!.edits).toHaveLength(2);
    expect(changes[0]!.lang).toBe('ts');
  });

  it('computes per-file add/del stats lazily via fileStats', () => {
    // Edit: +TWO +three -two => 2 add, 1 del ; MultiEdit: +K -k => 1 add, 1 del
    const a = fileStats([
      { oldText: 'one\ntwo', newText: 'one\nTWO\nthree' },
      { oldText: 'k', newText: 'K' },
    ]);
    expect(a).toEqual({ additions: 3, deletions: 2 });
    // Brand-new file: pure additions, no phantom deletion.
    expect(fileStats([{ oldText: '', newText: 'x\ny' }])).toEqual({ additions: 2, deletions: 0 });
  });

  it('includes files changed inside subagents', () => {
    const sub: SubagentRun = {
      agentId: 's1', agentType: 'general-purpose', description: 'd',
      messageCount: 1, toolCallCount: 1, totalTokens: 0,
      thread: [turn([tool('Write', { file_path: 'sub/c.py', content: 'print(1)' })])],
    };
    const changes = buildChangeset([], [sub]);
    expect(changes.map((c) => c.path)).toEqual(['sub/c.py']);
    expect(changes[0]!.lang).toBe('py');
  });

  it('ignores non-file tools and returns empty when nothing changed', () => {
    const thread = [turn([tool('Bash', { command: 'ls' }), tool('Read', { file_path: 'x.ts' })])];
    expect(buildChangeset(thread, [])).toEqual([]);
  });
});
