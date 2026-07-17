/**
 * Unit tests for the memory landing rollup (`buildConnectorOverviews`). Pure
 * over synthetic `AttributedMemory[]` — no DuckDB index, no agent home dirs.
 * Covers the bug-prone edges: newest-preview selection, instructions-only vs
 * no-provider connectors, and the markdown excerpt derivation.
 */

import { describe, expect, it } from 'vitest';
import type { AttributedMemory } from '../src/data/memory.js';
import { buildConnectorOverviews } from '../src/data/memory.js';

/** A project fact with sensible defaults; override what each case cares about. */
function fact(over: Partial<AttributedMemory> & { connectorId: string; updatedAt: string; title: string }): AttributedMemory {
  const { connectorId, updatedAt, title, label, projectId, ...rest } = over;
  return {
    connectorId,
    label: label ?? connectorId,
    scope: 'project',
    projectId: projectId ?? 'proj-a',
    source: {
      provenance: 'agent-authored',
      kind: 'fact',
      title,
      markdown: `# ${title}\n\nbody`,
      sourcePath: `~/.x/${title}.md`,
      updatedAt,
    },
    ...rest,
  };
}

describe('buildConnectorOverviews', () => {
  it('previews the newest project fact and counts distinct projects + total facts', () => {
    const items: AttributedMemory[] = [
      fact({ connectorId: 'claude-code', title: 'old', updatedAt: '2026-01-01T00:00:00.000Z', projectId: 'proj-a' }),
      fact({ connectorId: 'claude-code', title: 'newest', updatedAt: '2026-03-01T00:00:00.000Z', projectId: 'proj-b' }),
      fact({ connectorId: 'claude-code', title: 'mid', updatedAt: '2026-02-01T00:00:00.000Z', projectId: 'proj-b' }),
    ];
    const overviews = buildConnectorOverviews(items);
    const cc = overviews.find((o) => o.connectorId === 'claude-code')!;
    expect(cc.supported).toBe(true);
    expect(cc.globalFiles).toBe(0);
    expect(cc.totalFacts).toBe(3);
    expect(cc.projectsWithFacts).toBe(2); // proj-a + proj-b, distinct
    // Preview is the newest by updatedAt, regardless of input order.
    expect(cc.preview?.title).toBe('newest');
    expect(cc.preview?.scope).toBe('project');
  });

  it('gives an instructions-only connector (global source, no facts) a preview and supported=true', () => {
    const items: AttributedMemory[] = [
      {
        connectorId: 'codex',
        label: 'Codex',
        scope: 'global',
        source: {
          provenance: 'user-authored',
          kind: 'document',
          title: 'AGENTS.md (global)',
          description: 'House rules for the repo.',
          markdown: '# AGENTS\n\nrules',
          sourcePath: '~/.codex/AGENTS.md',
          updatedAt: '2026-04-01T00:00:00.000Z',
        },
      },
    ];
    const codex = buildConnectorOverviews(items).find((o) => o.connectorId === 'codex')!;
    expect(codex.supported).toBe(true);
    expect(codex.globalFiles).toBe(1);
    expect(codex.totalFacts).toBe(0);
    expect(codex.projectsWithFacts).toBe(0);
    expect(codex.preview).toBeDefined();
    expect(codex.preview?.scope).toBe('global');
    expect(codex.preview?.description).toBe('House rules for the repo.');
  });

  it('marks a no-provider connector supported=false with no preview', () => {
    // pi and opencode implement neither globalMemory nor projectMemory.
    const overviews = buildConnectorOverviews([]);
    for (const id of ['pi', 'opencode']) {
      const o = overviews.find((x) => x.connectorId === id)!;
      expect(o, id).toBeDefined();
      expect(o.supported, id).toBe(false);
      expect(o.preview, id).toBeUndefined();
      expect(o.totalFacts).toBe(0);
    }
  });

  it('derives a one-line excerpt from markdown when description is absent', () => {
    const items: AttributedMemory[] = [
      {
        connectorId: 'claude-code',
        label: 'Claude Code',
        scope: 'project',
        projectId: 'proj-a',
        source: {
          provenance: 'agent-authored',
          kind: 'fact',
          title: 'no-claude-co-author',
          // No description → excerpt comes from the body, with frontmatter and
          // markdown structure stripped and whitespace collapsed.
          markdown:
            '---\nname: no-claude-co-author\ntype: feedback\n---\n\n## Heading\n\nCommit as the *user* only and omit the [trailer](http://x).',
          sourcePath: '~/.claude/projects/x/memory/no-claude-co-author.md',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      },
    ];
    const cc = buildConnectorOverviews(items).find((o) => o.connectorId === 'claude-code')!;
    expect(cc.preview?.description).toBe(
      'Heading Commit as the user only and omit the trailer.',
    );
  });

  it('includes every registered connector and orders content > supported-empty > unsupported', () => {
    const items: AttributedMemory[] = [
      // claude-code has content (a fact) → rank 0.
      fact({ connectorId: 'claude-code', title: 'f', updatedAt: '2026-01-01T00:00:00.000Z' }),
      // codex/junie/copilot are supported but empty here → rank 1.
      // pi/opencode/grok are unsupported → rank 2.
    ];
    const overviews = buildConnectorOverviews(items);
    // Every registered agent appears (claude-code, codex, junie, pi, opencode, copilot, antigravity, grok).
    expect(overviews.map((o) => o.connectorId).sort()).toEqual(
      ['claude-code', 'codex', 'copilot', 'junie', 'opencode', 'pi', 'antigravity', 'grok'].sort(),
    );
    const rank = (o: { supported: boolean; preview?: unknown }) =>
      o.supported && o.preview ? 0 : o.supported ? 1 : 2;
    const ranks = overviews.map(rank);
    // Non-decreasing rank → the documented sort order holds.
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(overviews[0].connectorId).toBe('claude-code');
    // Unsupported ones sit last.
    expect(rank(overviews[overviews.length - 1])).toBe(2);
  });
});
