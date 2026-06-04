import { describe, expect, it } from 'vitest';
import type { SubagentRun, ThreadItem } from '@claudescope/shared';
import { buildChangeset } from '../src/pages/session/changeset.js';

function turn(blocks: ThreadItem['blocks']): ThreadItem {
  return { uuid: 'u', parentUuid: null, role: 'assistant', timestamp: 't', isSidechain: false, blocks };
}
const tool = (name: string, input: unknown) => ({ kind: 'tool' as const, id: name, name, input });

describe('buildChangeset', () => {
  it('groups Edit/MultiEdit/Write by file with add/del counts', () => {
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

    const a = changes[0]!;
    expect(a.edits).toHaveLength(2);
    expect(a.lang).toBe('ts');
    // Edit: +TWO +three -two  => 2 add, 1 del ; MultiEdit: +K -k => 1 add, 1 del
    expect(a.additions).toBe(3);
    expect(a.deletions).toBe(2);

    const b = changes[1]!;
    expect(b.additions).toBe(2); // brand-new file, two lines
    expect(b.deletions).toBe(0);
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
