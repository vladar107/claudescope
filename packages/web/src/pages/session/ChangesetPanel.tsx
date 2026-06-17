import { useEffect, useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { LineDiff } from '../../components';
import type { FileChange } from './changeset.js';
import { fileStats } from './changeset.js';

/** Abbreviate a path to its last two segments (e.g. "…/session/ThreadView.tsx"). */
function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join('/')}`;
}

/** Directory portion (with trailing slash) of a path, for the muted prefix. */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i + 1) : '';
}
function baseOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * "Files changed" view — master/detail: a session diffstat on top, a left rail
 * of changed files (each with per-file +/− counts), and the selected file's diff
 * on the right. Per-file line stats run `lineDiff`, so they're computed only once
 * the tab has actually been opened (`active`).
 */
export function ChangesetPanel({ changes, active }: { changes: FileChange[]; active: boolean }) {
  // Defer the (potentially heavy) all-files stat computation until the tab is
  // first opened, so loading a session never pays for a view it may not see.
  const [everActive, setEverActive] = useState(active);
  useEffect(() => {
    if (active && !everActive) setEverActive(true);
  }, [active, everActive]);

  const stats = useMemo(
    () => (everActive ? changes.map((c) => fileStats(c.edits)) : null),
    [everActive, changes],
  );

  const [selected, setSelected] = useState(0);
  // Reset the selection when the changeset swaps (new session / soft refresh).
  useEffect(() => setSelected(0), [changes]);

  if (changes.length === 0) {
    return <p className="tv-muted">This session changed no files.</p>;
  }

  const totals = stats
    ? stats.reduce(
        (acc, s) => ({ additions: acc.additions + s.additions, deletions: acc.deletions + s.deletions }),
        { additions: 0, deletions: 0 },
      )
    : null;
  const idx = Math.min(selected, changes.length - 1);
  const current = changes[idx];
  if (!current) return null;
  const currentStat = stats?.[idx] ?? null;

  return (
    <div className="tv-changeset">
      <div className="tv-changeset__bar">
        <div className="tv-changeset__diffstat">
          <span>
            {changes.length} file{changes.length === 1 ? '' : 's'}
          </span>
          {totals ? (
            <>
              <span className="tv-diff-add">+{totals.additions}</span>
              <span className="tv-diff-del">−{totals.deletions}</span>
            </>
          ) : null}
        </div>
      </div>

      <div className="tv-changeset__panes">
        <ul className="tv-changeset__rail">
          {changes.map((c, i) => {
            const s = stats?.[i];
            return (
              <li key={c.path}>
                <button
                  type="button"
                  className={i === idx ? 'tv-changeset__railbtn is-active' : 'tv-changeset__railbtn'}
                  onClick={() => setSelected(i)}
                  title={c.path}
                >
                  <span className="tv-mono tv-changeset__railpath">{shortPath(c.path)}</span>
                  <span className="tv-changeset__railstat">
                    <span
                      className="tv-changeset__edits"
                      title={`${c.edits.length} edit${c.edits.length === 1 ? '' : 's'}`}
                    >
                      <Pencil size={11} aria-hidden="true" />
                      {c.edits.length}
                    </span>
                    {s ? (
                      <>
                        {s.additions > 0 ? <span className="tv-diff-add">+{s.additions}</span> : null}
                        {s.deletions > 0 ? <span className="tv-diff-del">−{s.deletions}</span> : null}
                      </>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="tv-changeset__detail">
          <div className="tv-changeset__detail-head">
            <span className="tv-mono tv-changeset__detail-path" title={current.path}>
              {dirOf(current.path)}
              <strong>{baseOf(current.path)}</strong>
            </span>
            <span className="tv-changeset__railstat">
              <span className="tv-changeset__edits">
                {current.edits.length} edit{current.edits.length === 1 ? '' : 's'}
              </span>
              {currentStat ? (
                <>
                  <span className="tv-diff-add">+{currentStat.additions}</span>
                  <span className="tv-diff-del">−{currentStat.deletions}</span>
                </>
              ) : null}
            </span>
          </div>
          <div className="tv-changeset__diffs">
            {current.edits.map((e, i) => (
              <LineDiff key={i} oldText={e.oldText} newText={e.newText} lang={current.lang} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
