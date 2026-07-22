/**
 * Codex memory — read live from `~/.codex`, never indexed.
 *
 * Two provenances surface here, in display order:
 *   1. `~/.codex/AGENTS.md` — the user-authored global instruction file.
 *   2. `~/.codex/memories/{MEMORY.md,memory_summary.md}` — Codex's own
 *      agent-distilled global handbook/summary. This store is experimental,
 *      off-by-default, and geo-gated, so it is absent for essentially everyone;
 *      it is read best-effort and simply omitted when missing or empty.
 *
 * STRICTLY READ-ONLY with respect to ~/.codex — files are only ever read.
 * Every store is usually absent: missing files yield `[]`, never an error.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MemorySource } from '@claudescope/shared';
import { codexHome } from '../../settings.js';
import { contractHome } from '../../util/paths.js';

/**
 * Read a memory file into a `MemorySource`, or `undefined` if it's absent or
 * empty (or unreadable). Best-effort: every read is wrapped so an absent store
 * — the common case — degrades to omission, never an error.
 */
function readSource(
  path: string,
  base: Pick<MemorySource, 'provenance' | 'kind' | 'title'>,
): MemorySource | undefined {
  try {
    const markdown = readFileSync(path, 'utf8');
    if (!markdown.trim()) return undefined;
    return {
      ...base,
      markdown,
      sourcePath: contractHome(path),
      updatedAt: new Date(statSync(path).mtimeMs).toISOString(),
    };
  } catch {
    return undefined;
  }
}

/**
 * Codex's global, cross-project memory: the user-authored `AGENTS.md` plus the
 * best-effort agent-authored `memories/` handbook and summary. Per-project
 * Codex attribution (the `memories_*.sqlite`/`state_*.sqlite` cwd join) is
 * deferred and intentionally not read here.
 */
export function codexGlobalMemory(): MemorySource[] {
  const out: MemorySource[] = [];

  // Instruction file first: the user-authored global AGENTS.md.
  const agents = readSource(join(codexHome(), 'AGENTS.md'), {
    provenance: 'user-authored',
    kind: 'document',
    title: 'AGENTS.md (global)',
  });
  if (agents) out.push(agents);

  // Best-effort agent-authored handbook + summary; absent for almost everyone.
  const memoriesDir = join(codexHome(), 'memories');
  const handbook = readSource(join(memoriesDir, 'MEMORY.md'), {
    provenance: 'agent-authored',
    kind: 'document',
    title: 'Codex memory handbook',
  });
  if (handbook) out.push(handbook);

  const summary = readSource(join(memoriesDir, 'memory_summary.md'), {
    provenance: 'agent-authored',
    kind: 'document',
    title: 'Codex memory summary',
  });
  if (summary) out.push(summary);

  return out;
}
