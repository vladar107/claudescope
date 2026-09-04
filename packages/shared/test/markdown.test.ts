import { describe, expect, it } from 'vitest';
import type { SessionDetailResponse, SubagentRun, ThreadItem } from '../src/index.js';
import {
  orderSubagentRunsDepthFirst,
  redactText,
  sessionToMarkdown,
  threadItemsToMarkdown,
  truncateText,
} from '../src/index.js';

describe('redactText', () => {
  it('masks home-dir paths to ~', () => {
    expect(redactText('see /Users/alice/src/app/x.ts')).toBe('see ~/src/app/x.ts');
    expect(redactText('/home/bob/notes')).toBe('~/notes');
  });

  it('masks common secret formats', () => {
    expect(redactText('key sk-abcdefghijklmnop1234')).toContain('«redacted-key»');
    expect(redactText('token ghp_' + 'a'.repeat(36))).toContain('«redacted-token»');
    expect(redactText('Authorization: Bearer abcdef0123456789ABCDEF')).toContain('Bearer «redacted»');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactText('just a normal sentence with no secrets')).toBe(
      'just a normal sentence with no secrets',
    );
  });
});

describe('truncateText', () => {
  it('reports exactly how many chars were dropped', () => {
    expect(truncateText('a'.repeat(100), 40)).toBe('a'.repeat(40) + '… [truncated, 60 more chars]');
  });

  it('leaves text at or under the cap untouched, and ignores a zero cap', () => {
    expect(truncateText('short', 5)).toBe('short');
    expect(truncateText('anything', 0)).toBe('anything');
  });
});

function turn(role: 'user' | 'assistant', blocks: ThreadItem['blocks'], model?: string): ThreadItem {
  return { uuid: 'u', parentUuid: null, role, timestamp: '2026-01-01T00:00:00Z', isSidechain: false, blocks, ...(model ? { model } : {}) };
}

const baseMeta: SessionDetailResponse['meta'] = {
  id: 's1', projectId: 'p', projectDisplayName: 'p', title: 'My session', startedAt: '2026-01-01T00:00:00Z',
  endedAt: '2026-01-01T01:00:00Z', messageCount: 2, toolCallCount: 1, totalTokens: 1234,
  totalCostUsd: 0.5, models: ['claude-opus-4-8'], sizeBytes: 100, hasSidechain: false,
  connectorId: 'claude-code',
};

describe('sessionToMarkdown', () => {
  const data: SessionDetailResponse = {
    meta: baseMeta,
    thread: [
      turn('user', [{ kind: 'text', type: 'text', text: 'Edit the file at /Users/me/app/settings.ts' }]),
      turn('assistant', [
        { kind: 'text', type: 'text', text: 'Done.' },
        { kind: 'tool', id: 't', name: 'Edit', input: { file_path: 'settings.ts', old_string: 'a', new_string: 'b' } },
      ], 'claude-opus-4-8'),
    ],
    subagents: [],
  };

  it('produces a titled Markdown doc with role headings and a diff fence', () => {
    const md = sessionToMarkdown(data, { redact: false });
    expect(md).toContain('# My session');
    expect(md).toContain('### 👤 User');
    expect(md).toContain('### 🤖 Assistant · claude-opus-4-8');
    expect(md).toContain('```diff');
    expect(md).toContain('-a');
    expect(md).toContain('+b');
  });

  it('applies redaction when requested', () => {
    const plain = sessionToMarkdown(data, { redact: false });
    const red = sessionToMarkdown(data, { redact: true });
    expect(plain).toContain('/Users/me/app/settings.ts');
    expect(red).not.toContain('/Users/me/');
    expect(red).toContain('~/app/settings.ts');
    expect(red).toContain('redaction');
  });
});

function subagentRun(agentId: string, description: string, parentAgentId?: string): SubagentRun {
  return {
    agentId,
    agentType: 'general-purpose',
    description,
    ...(parentAgentId ? { parentAgentId } : {}),
    messageCount: 0,
    toolCallCount: 0,
    totalTokens: 0,
    thread: [],
  };
}

describe('orderSubagentRunsDepthFirst', () => {
  it('places each run immediately after its parent, children in list order', () => {
    const parent = subagentRun('parent', 'Explore X');
    const unlinked = subagentRun('unlinked', 'separate task');
    const child = subagentRun('child', 'nested probe', 'parent');
    // The child is listed AFTER the unrelated root run — it must still be
    // promoted to sit right after its own parent, not stay where it was.
    expect(orderSubagentRunsDepthFirst([parent, unlinked, child]).map((r) => r.agentId)).toEqual([
      'parent',
      'child',
      'unlinked',
    ]);
  });

  it('renders a run with a dangling parentAgentId as top-level', () => {
    const orphan = subagentRun('orphan', 'ghost parent', 'missing');
    const other = subagentRun('other', 'unrelated');
    expect(orderSubagentRunsDepthFirst([orphan, other]).map((r) => r.agentId)).toEqual(['orphan', 'other']);
  });

  it('terminates on a parent cycle instead of hanging', () => {
    const a = subagentRun('a', 'A', 'b');
    const b = subagentRun('b', 'B', 'a');
    const ordered = orderSubagentRunsDepthFirst([a, b]);
    expect(ordered.map((r) => r.agentId).sort()).toEqual(['a', 'b']);
  });
});

describe('sessionToMarkdown — nested subagents', () => {
  const parentRun: SubagentRun = {
    ...subagentRun('parent', 'Explore X'),
    thread: [turn('assistant', [{ kind: 'text', type: 'text', text: 'parent work' }])],
  };
  const childRun: SubagentRun = {
    ...subagentRun('child', 'nested probe', 'parent'),
    thread: [turn('assistant', [{ kind: 'text', type: 'text', text: 'child work' }])],
  };
  const data: SessionDetailResponse = {
    meta: baseMeta,
    thread: [],
    subagents: [childRun, parentRun], // list order is not depth-first
  };

  it('orders runs depth-first and labels the nested one with its parent', () => {
    const md = sessionToMarkdown(data, { redact: false });
    expect(md).toContain('### 🧩 Subagent · general-purpose — Explore X');
    expect(md).toContain('### 🧩 Subagent · general-purpose — nested probe (nested in Explore X)');
    expect(md.indexOf('Explore X')).toBeLessThan(md.indexOf('nested probe'));
  });
});

describe('threadItemsToMarkdown with maxToolChars', () => {
  const bigResult = 'x'.repeat(500);
  const items: ThreadItem[] = [
    turn('assistant', [
      {
        kind: 'tool',
        id: 't1',
        name: 'Bash',
        input: { command: 'echo hi' },
        result: { isError: false, content: [{ type: 'text', text: bigResult }] },
      },
    ], 'claude-opus-4-8'),
    turn('user', [{ kind: 'text', type: 'text', text: 'prose is never truncated '.repeat(20) }]),
  ];

  it('caps tool payloads but not prose', () => {
    const md = threadItemsToMarkdown(items, { redact: false, maxToolChars: 50 });
    expect(md).toContain('… [truncated, 450 more chars]');
    expect(md).not.toContain(bigResult);
    expect(md).toContain('prose is never truncated '.repeat(20).trim());
  });

  it('leaves everything intact without a cap', () => {
    const md = threadItemsToMarkdown(items, { redact: false });
    expect(md).toContain(bigResult);
    expect(md).not.toContain('[truncated');
  });
});
