/**
 * Derive a session "changeset" — every file the agent touched via Edit /
 * MultiEdit / Write. Pure (no React/DOM/DB), shared by the web Files-changed
 * tab (grouped by path) and the server's index-time `file_edits` extraction
 * (one record per edit-bearing tool call).
 */

import type { SubagentRun, ThreadItem } from './thread.js';
import { diffStats, extOf, lineDiff } from './diff.js';

export interface FileEdit {
  oldText: string;
  newText: string;
}

export interface FileChange {
  path: string;
  lang?: string;
  edits: FileEdit[];
}

/**
 * One edit-bearing tool call (canonical `Edit`/`MultiEdit`/`Write`) with its
 * addressing metadata, so index-time extraction can key rows by
 * `(uuid, tool_use_id)` for fork dedup. `edits` holds one pair for
 * Edit/Write and one per inner edit for MultiEdit.
 */
export interface EditToolCall {
  path: string;
  toolName: string;
  /** uuid of the thread item carrying the tool_use block. */
  uuid: string;
  /** The tool_use block id ('' when the format carries none). */
  toolUseId: string;
  timestamp: string;
  isSidechain: boolean;
  edits: FileEdit[];
}

/** Added/removed line counts for a file's edits. Computed lazily (runs lineDiff). */
export function fileStats(edits: FileEdit[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const e of edits) {
    const s = diffStats(lineDiff(e.oldText, e.newText));
    additions += s.additions;
    deletions += s.deletions;
  }
  return { additions, deletions };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function collect(thread: ThreadItem[], sidechain: boolean, out: EditToolCall[]): void {
  for (const turn of thread) {
    for (const block of turn.blocks) {
      if (block.kind !== 'tool') continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const path = typeof input.file_path === 'string' ? input.file_path : '';
      if (!path) continue;

      let edits: FileEdit[] | null = null;
      if (block.name === 'Edit') {
        edits = [{ oldText: str(input.old_string), newText: str(input.new_string) }];
      } else if (block.name === 'MultiEdit') {
        const list = Array.isArray(input.edits) ? input.edits : [];
        edits = list.map((e) => {
          const er = (e ?? {}) as Record<string, unknown>;
          return { oldText: str(er.old_string), newText: str(er.new_string) };
        });
      } else if (block.name === 'Write') {
        edits = [{ oldText: '', newText: str(input.content) }];
      }
      if (!edits) continue;

      out.push({
        path,
        toolName: block.name,
        uuid: turn.uuid,
        toolUseId: block.id ?? '',
        timestamp: turn.timestamp,
        isSidechain: sidechain || turn.isSidechain,
        edits,
      });
    }
  }
}

/**
 * Every edit-bearing tool call in a session (main thread first, then each
 * subagent run), in document order.
 */
export function collectEditCalls(thread: ThreadItem[], subagents: SubagentRun[]): EditToolCall[] {
  const out: EditToolCall[] = [];
  collect(thread, false, out);
  for (const run of subagents) collect(run.thread, true, out);
  return out;
}

/**
 * Build the changeset for a session (main thread + subagents), in the order
 * files were first touched. Cheap: only groups edits by file — line-level
 * add/remove stats are computed lazily per file via {@link fileStats}.
 */
export function buildChangeset(thread: ThreadItem[], subagents: SubagentRun[]): FileChange[] {
  const byPath = new Map<string, FileEdit[]>();
  for (const call of collectEditCalls(thread, subagents)) {
    const list = byPath.get(call.path) ?? [];
    list.push(...call.edits);
    byPath.set(call.path, list);
  }

  const changes: FileChange[] = [];
  for (const [path, edits] of byPath) {
    const lang = extOf(path);
    changes.push({ path, edits, ...(lang ? { lang } : {}) });
  }
  return changes;
}
