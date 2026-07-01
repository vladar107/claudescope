/**
 * Google Antigravity memory — read live from `~/.gemini`, never indexed.
 *
 * Antigravity writes global rules to `~/.gemini/config/agents/AGENTS.md` (observed
 * when it self-configures) and also honors a top-level `~/.gemini/GEMINI.md`. Both
 * are surfaced as global, cross-project memory (analog of `~/.claude/CLAUDE.md`).
 *
 * No per-project memory: Antigravity's per-conversation `brain/<id>/` docs
 * (implementation_plan.md, task.md, walkthrough.md) are session artifacts, not a
 * cross-session per-project store, so `projectMemory()` is omitted.
 *
 * STRICTLY READ-ONLY with respect to ~/.gemini — files are only ever read.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MemorySource } from '@claudescope/shared';
import { ANTIGRAVITY_HOME } from '../../config.js';
import { contractHome } from '../../util/paths.js';

/**
 * Antigravity's global, cross-project memory. Absent for most users → `[]`, never
 * an error.
 */
export function antigravityGlobalMemory(): MemorySource[] {
  const candidates: { path: string; title: string }[] = [
    { path: join(ANTIGRAVITY_HOME, 'config', 'agents', 'AGENTS.md'), title: 'AGENTS.md (global)' },
    { path: join(ANTIGRAVITY_HOME, 'GEMINI.md'), title: 'GEMINI.md (global)' },
  ];
  const out: MemorySource[] = [];
  for (const c of candidates) {
    try {
      const markdown = readFileSync(c.path, 'utf8');
      if (!markdown.trim()) continue;
      out.push({
        provenance: 'user-authored',
        kind: 'document',
        title: c.title,
        markdown,
        sourcePath: contractHome(c.path),
        updatedAt: new Date(statSync(c.path).mtimeMs).toISOString(),
      });
    } catch {
      /* absent → skip */
    }
  }
  return out;
}
