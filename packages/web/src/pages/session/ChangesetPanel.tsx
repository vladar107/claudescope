import { useMemo, useState } from 'react';
import { LineDiff } from '../../components';
import type { FileChange } from './changeset.js';
import { fileStats } from './changeset.js';

/**
 * "Files changed" view (rendered only when its tab is active). Each file is
 * collapsed by default; its line stats and syntax-highlighted diffs are computed
 * only when expanded — so opening the tab is instant even for big sessions.
 */
export function ChangesetPanel({ changes }: { changes: FileChange[] }) {
  if (changes.length === 0) {
    return <p className="tv-muted">This session changed no files.</p>;
  }
  return (
    <ul className="tv-changeset__list">
      {changes.map((c) => (
        <FileRow key={c.path} change={c} />
      ))}
    </ul>
  );
}

function FileRow({ change }: { change: FileChange }) {
  const [open, setOpen] = useState(false);
  // Stats run lineDiff — compute only once the file is expanded.
  const stats = useMemo(() => (open ? fileStats(change.edits) : null), [open, change.edits]);

  return (
    <li className="tv-changeset__file">
      <button
        type="button"
        className="tv-changeset__summary"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tv-changeset__chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="tv-mono tv-changeset__path">{change.path}</span>
        <span className="tv-changeset__stat">
          {stats ? (
            <>
              <span className="tv-diff-add">+{stats.additions}</span>{' '}
              <span className="tv-diff-del">−{stats.deletions}</span>
            </>
          ) : (
            <span className="tv-muted">
              {change.edits.length} edit{change.edits.length === 1 ? '' : 's'}
            </span>
          )}
        </span>
      </button>
      {open ? (
        <div className="tv-changeset__diffs">
          {change.edits.map((e, i) => (
            <LineDiff key={i} oldText={e.oldText} newText={e.newText} lang={change.lang} />
          ))}
        </div>
      ) : null}
    </li>
  );
}
