/**
 * Derive a session "changeset" — every file the agent touched via Edit /
 * MultiEdit / Write, grouped by path, with added/removed line counts. Pure
 * (no React/DOM), so it's unit-testable.
 */

import type { SubagentRun, ThreadItem } from '@claudescope/shared';
import { diffStats, extOf, lineDiff } from '../../components/diff.js';

export interface FileEdit {
  oldText: string;
  newText: string;
}

export interface FileChange {
  path: string;
  lang?: string;
  edits: FileEdit[];
  additions: number;
  deletions: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function collect(thread: ThreadItem[], byPath: Map<string, FileEdit[]>): void {
  for (const turn of thread) {
    for (const block of turn.blocks) {
      if (block.kind !== 'tool') continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const path = typeof input.file_path === 'string' ? input.file_path : '';
      if (!path) continue;

      const push = (edits: FileEdit[]) => {
        const list = byPath.get(path) ?? [];
        list.push(...edits);
        byPath.set(path, list);
      };

      if (block.name === 'Edit') {
        push([{ oldText: str(input.old_string), newText: str(input.new_string) }]);
      } else if (block.name === 'MultiEdit') {
        const edits = Array.isArray(input.edits) ? input.edits : [];
        push(
          edits.map((e) => {
            const er = (e ?? {}) as Record<string, unknown>;
            return { oldText: str(er.old_string), newText: str(er.new_string) };
          }),
        );
      } else if (block.name === 'Write') {
        push([{ oldText: '', newText: str(input.content) }]);
      }
    }
  }
}

/**
 * Build the changeset for a session (main thread + subagents), in the order
 * files were first touched.
 */
export function buildChangeset(thread: ThreadItem[], subagents: SubagentRun[]): FileChange[] {
  const byPath = new Map<string, FileEdit[]>();
  collect(thread, byPath);
  for (const run of subagents) collect(run.thread, byPath);

  const changes: FileChange[] = [];
  for (const [path, edits] of byPath) {
    let additions = 0;
    let deletions = 0;
    for (const e of edits) {
      const s = diffStats(lineDiff(e.oldText, e.newText));
      additions += s.additions;
      deletions += s.deletions;
    }
    const lang = extOf(path);
    changes.push({ path, edits, additions, deletions, ...(lang ? { lang } : {}) });
  }
  return changes;
}
