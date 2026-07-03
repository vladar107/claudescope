/**
 * digestToMarkdown edges: n/a rendering for an unknowable error rate, the
 * no-signal agents note, empty-section omission, and the empty-range document.
 */

import { describe, expect, it } from 'vitest';
import type { DigestResponse } from '../src/api.js';
import { digestToMarkdown } from '../src/digest-markdown.js';

function base(overrides: Partial<DigestResponse> = {}): DigestResponse {
  return {
    from: '2026-06-23T00:00:00.000Z',
    to: '2026-06-29T23:59:59.999Z',
    totals: { sessions: 3, activeProjects: 2, responses: 40, totalTokens: 12345, costUsd: 1.5 },
    topProjects: [
      { projectId: 'p-1', cwd: '/src/app', sessions: 2, totalTokens: 10000, costUsd: 1.2 },
    ],
    models: [{ key: 'claude-opus-4-8', count: 30 }],
    topTools: [{ key: 'Bash', count: 12 }],
    agents: [{ key: 'claude-code', count: 3 }],
    biggestSession: { id: 's1', title: 'Fix the bug', connectorId: 'claude-code', costUsd: 1.0, totalTokens: 8000 },
    streak: { current: 4, longest: 9, lastActiveDay: '2026-06-29' },
    impact: {
      additions: 120,
      deletions: 30,
      edits: 15,
      filesTouched: 6,
      topFiles: [{ path: '/src/app/index.ts', additions: 80, deletions: 10 }],
    },
    errors: { toolCalls: 100, toolErrors: 4, errorRate: 0.04, unknownAgents: ['junie'] },
    interrupts: 2,
    ...overrides,
  };
}

describe('digestToMarkdown', () => {
  it('renders the full document with the no-signal agents note', () => {
    const md = digestToMarkdown(base());
    expect(md).toContain('# Week in review — 2026-06-23 → 2026-06-29');
    expect(md).toContain('Tool errors: 4 of 100 calls (4.0%) — no signal from junie');
    expect(md).toContain('Interrupts (Claude Code): 2');
    expect(md).toContain('- `/src/app/index.ts` (+80/−10)');
    expect(md).toContain('Prompt streak: 4 days (longest 9)');
  });

  it('renders n/a when the error rate is unknowable', () => {
    const md = digestToMarkdown(
      base({ errors: { toolCalls: 0, toolErrors: 0, errorRate: null, unknownAgents: [] } }),
    );
    expect(md).toContain('(n/a)');
  });

  it('omits sections with nothing to say', () => {
    const md = digestToMarkdown(
      base({
        impact: { additions: 0, deletions: 0, edits: 0, filesTouched: 0, topFiles: [] },
        errors: null,
        interrupts: null,
        streak: { current: 0, longest: 0, lastActiveDay: null },
        biggestSession: null,
        topTools: [],
        models: [],
      }),
    );
    expect(md).not.toContain('## Code impact');
    expect(md).not.toContain('## Reliability');
    expect(md).not.toContain('## Momentum');
    expect(md).not.toContain('## Top tools');
    expect(md).not.toContain('## Models');
  });

  it('collapses to a one-line document for an empty range', () => {
    const md = digestToMarkdown(
      base({ totals: { sessions: 0, activeProjects: 0, responses: 0, totalTokens: 0, costUsd: 0 } }),
    );
    expect(md).toContain('_No sessions in range._');
    expect(md).not.toContain('##');
  });
});
