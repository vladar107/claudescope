import { describe, expect, it } from 'vitest';
import type { SessionDetailResponse, ThreadItem } from '@claudescope/shared';
import { redactText, sessionToMarkdown } from '../src/pages/session/export.js';

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

function turn(role: 'user' | 'assistant', blocks: ThreadItem['blocks'], model?: string): ThreadItem {
  return { uuid: 'u', parentUuid: null, role, timestamp: '2026-01-01T00:00:00Z', isSidechain: false, blocks, ...(model ? { model } : {}) };
}

const baseMeta: SessionDetailResponse['meta'] = {
  id: 's1', projectId: 'p', title: 'My session', startedAt: '2026-01-01T00:00:00Z',
  endedAt: '2026-01-01T01:00:00Z', messageCount: 2, toolCallCount: 1, totalTokens: 1234,
  totalCostUsd: 0.5, models: ['claude-opus-4-8'], sizeBytes: 100, hasSidechain: false,
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
