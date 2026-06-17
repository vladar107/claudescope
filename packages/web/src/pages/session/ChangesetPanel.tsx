import { useEffect, useMemo, useState } from 'react';
import { LineDiff } from '../../components';
import type { FileChange } from './changeset.js';
import { fileStats } from './changeset.js';

const VIEWED_PREFIX = 'cs.viewed.';

/** Load the set of file paths marked "viewed" for a session (client-only state). */
function loadViewed(sessionId: string): Set<string> {
  try {
    const raw = localStorage.getItem(VIEWED_PREFIX + sessionId);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore unavailable/garbage storage */
  }
  return new Set();
}

function saveViewed(sessionId: string, viewed: Set<string>): void {
  try {
    localStorage.setItem(VIEWED_PREFIX + sessionId, JSON.stringify([...viewed]));
  } catch {
    /* ignore */
  }
}

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
 * "Files changed" view — a master/detail review surface: a session diffstat and
 * a "viewed" progress bar on top, a left rail of changed files (each with a
 * viewed checkbox and per-file +/− counts), and the selected file's diff on the
 * right. Per-file line stats run `lineDiff`, so they're computed only once the
 * tab has actually been opened (`active`). "Viewed" state persists in
 * localStorage per session — a lightweight, code-review-style pass.
 */
export function ChangesetPanel({
  changes,
  sessionId,
  active,
}: {
  changes: FileChange[];
  sessionId: string;
  active: boolean;
}) {
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
  const [viewed, setViewed] = useState<Set<string>>(() => loadViewed(sessionId));

  // A soft refresh swaps the session id → reset selection and reload viewed.
  useEffect(() => {
    setSelected(0);
    setViewed(loadViewed(sessionId));
  }, [sessionId]);

  if (changes.length === 0) {
    return <p className="tv-muted">This session changed no files.</p>;
  }

  const toggleViewed = (path: string) =>
    setViewed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      saveViewed(sessionId, next);
      return next;
    });

  const totals = stats
    ? stats.reduce(
        (acc, s) => ({ additions: acc.additions + s.additions, deletions: acc.deletions + s.deletions }),
        { additions: 0, deletions: 0 },
      )
    : null;
  const viewedCount = changes.reduce((n, c) => n + (viewed.has(c.path) ? 1 : 0), 0);
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
        <div className="tv-changeset__progress">
          <span className="tv-changeset__progress-bar" aria-hidden="true">
            <span
              className="tv-changeset__progress-fill"
              style={{ width: `${(viewedCount / changes.length) * 100}%` }}
            />
          </span>
          <span className="tv-muted">
            {viewedCount} of {changes.length} viewed
          </span>
        </div>
      </div>

      <div className="tv-changeset__panes">
        <ul className="tv-changeset__rail">
          {changes.map((c, i) => {
            const s = stats?.[i];
            return (
              <li
                key={c.path}
                className={i === idx ? 'tv-changeset__railrow is-active' : 'tv-changeset__railrow'}
              >
                <input
                  type="checkbox"
                  className="tv-changeset__viewed"
                  checked={viewed.has(c.path)}
                  onChange={() => toggleViewed(c.path)}
                  aria-label={`Mark ${c.path} viewed`}
                  title="Viewed"
                />
                <button type="button" className="tv-changeset__railbtn" onClick={() => setSelected(i)} title={c.path}>
                  <span className="tv-mono tv-changeset__railpath">{shortPath(c.path)}</span>
                  {s ? (
                    <span className="tv-changeset__railstat">
                      {s.additions > 0 ? <span className="tv-diff-add">+{s.additions}</span> : null}
                      {s.deletions > 0 ? <span className="tv-diff-del">−{s.deletions}</span> : null}
                    </span>
                  ) : null}
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
            {currentStat ? (
              <span className="tv-changeset__railstat">
                <span className="tv-diff-add">+{currentStat.additions}</span>
                <span className="tv-diff-del">−{currentStat.deletions}</span>
              </span>
            ) : null}
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
