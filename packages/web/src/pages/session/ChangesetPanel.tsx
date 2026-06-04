import { useMemo } from 'react';
import type { SubagentRun, ThreadItem } from '@claudescope/shared';
import { Collapsible, LineDiff } from '../../components';
import { buildChangeset } from './changeset.js';

/**
 * A collapsible "Files changed" panel summarizing every Edit/MultiEdit/Write in
 * the session (main thread + subagents), grouped by file with per-file diffs.
 * Renders nothing if the session changed no files.
 */
export function Changeset({ thread, subagents }: { thread: ThreadItem[]; subagents: SubagentRun[] }) {
  const changes = useMemo(() => buildChangeset(thread, subagents), [thread, subagents]);
  if (changes.length === 0) return null;

  const additions = changes.reduce((n, c) => n + c.additions, 0);
  const deletions = changes.reduce((n, c) => n + c.deletions, 0);

  return (
    <Collapsible
      className="tv-changeset"
      icon="📝"
      title="Files changed"
      subtitle={`${changes.length} file${changes.length === 1 ? '' : 's'}`}
      headerExtra={
        <span className="tv-changeset__totals">
          <span className="tv-diff-add">+{additions}</span>{' '}
          <span className="tv-diff-del">−{deletions}</span>
        </span>
      }
    >
      <ul className="tv-changeset__list">
        {changes.map((c) => (
          <li key={c.path}>
            <details className="tv-changeset__file">
              <summary>
                <span className="tv-mono tv-changeset__path">{c.path}</span>
                <span className="tv-changeset__stat">
                  <span className="tv-diff-add">+{c.additions}</span>{' '}
                  <span className="tv-diff-del">−{c.deletions}</span>
                  {c.edits.length > 1 ? (
                    <span className="tv-muted"> · {c.edits.length} edits</span>
                  ) : null}
                </span>
              </summary>
              <div className="tv-changeset__diffs">
                {c.edits.map((e, i) => (
                  <LineDiff key={i} oldText={e.oldText} newText={e.newText} lang={c.lang} />
                ))}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </Collapsible>
  );
}
