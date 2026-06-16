/**
 * GitHub Copilot CLI memory — read live from `~/.copilot`, never indexed.
 *
 * One store surfaces: `~/.copilot/copilot-instructions.md` — the user-authored
 * global instruction file (analog of `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md`).
 *
 * No per-project memory: Copilot's "session-level memory" persists facts/todos in
 * the per-session `session.db` and attachments in `session-state/<uuid>/files/`,
 * all session-scoped (cleared on `/clear`), not a cross-session per-project store.
 * Its real memory subsystem was disabled in every observed install, so the on-disk
 * shape of any genuine project memory is unconfirmed — `projectMemory()` is omitted
 * until a user with it enabled surfaces a real store.
 *
 * STRICTLY READ-ONLY with respect to ~/.copilot — the file is only ever read.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MemorySource } from '@claudescope/shared';
import { COPILOT_HOME } from '../../config.js';
import { contractHome } from '../../util/paths.js';

/**
 * Copilot's global, cross-project memory: the user-authored `copilot-instructions.md`.
 * Absent for most users → `[]`, never an error.
 */
export function copilotGlobalMemory(): MemorySource[] {
  const path = join(COPILOT_HOME, 'copilot-instructions.md');
  try {
    const markdown = readFileSync(path, 'utf8');
    if (!markdown.trim()) return [];
    return [
      {
        provenance: 'user-authored',
        kind: 'document',
        title: 'copilot-instructions.md (global)',
        markdown,
        sourcePath: contractHome(path),
        updatedAt: new Date(statSync(path).mtimeMs).toISOString(),
      },
    ];
  } catch {
    return [];
  }
}
