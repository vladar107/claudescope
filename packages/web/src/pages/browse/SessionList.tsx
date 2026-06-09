import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProjectMeta, SessionMeta, SessionSort } from '@claudescope/shared';
import { api, ApiError } from '../../api/client.js';
import { AgentBadge, CostBadge, ErrorBox, Spinner, TokenChips } from '../../components';
import { formatBytes, formatDateTime, shortModel, timeAgo } from './format.js';

interface SessionListProps {
  project: ProjectMeta;
  onBack: () => void;
}

const SORT_OPTIONS: { value: SessionSort; label: string }[] = [
  { value: 'recent', label: 'Most recent' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'tokens', label: 'Most tokens' },
  { value: 'cost', label: 'Highest cost' },
  { value: 'messages', label: 'Most messages' },
];

/**
 * Sessions for a single project. Sort is server-driven (re-fetches on change);
 * the text filter is applied client-side against title / branch / id.
 */
export function SessionList({ project, onBack }: SessionListProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sort, setSort] = useState<SessionSort>('recent');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .listSessions({ project: project.id, sort }, controller.signal)
      .then((data) => {
        setSessions(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof ApiError && err.status === 0) return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, [project.id, sort, reloadKey]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const haystack = [s.title, s.gitBranch ?? '', s.id, s.models.join(' ')]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [sessions, filter]);

  return (
    <section>
      <div className="tv-browse__crumbs">
        <button type="button" className="tv-linkbtn" onClick={onBack}>
          ← Projects
        </button>
        <span className="tv-muted"> / </span>
        <span className="tv-mono">{project.displayName}</span>
      </div>

      <header className="tv-browse__header">
        <div>
          <h1 className="tv-page-title" style={{ marginBottom: 4 }}>
            {project.displayName}
          </h1>
          <div className="tv-muted tv-mono" style={{ fontSize: 'var(--tv-fs-sm)' }}>
            {project.cwd}
          </div>
        </div>
        <div className="tv-browse__controls">
          <input
            className="tv-input"
            type="search"
            placeholder="Filter sessions…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            className="tv-select"
            value={sort}
            onChange={(e) => setSort(e.target.value as SessionSort)}
            aria-label="Sort sessions"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      {loading ? (
        <Spinner size="lg" label="Loading sessions…" />
      ) : error ? (
        <ErrorBox error={error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : filtered.length === 0 ? (
        <p className="tv-muted">{sessions.length === 0 ? 'No sessions.' : 'No sessions match the filter.'}</p>
      ) : (
        <>
          <div className="tv-muted" style={{ marginBottom: 'var(--tv-space-3)' }}>
            {filtered.length} session{filtered.length === 1 ? '' : 's'}
            {filter ? ` (of ${sessions.length})` : ''}
          </div>
          <ul className="tv-list">
            {filtered.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function SessionRow({ session }: { session: SessionMeta }) {
  const title = session.title || 'Untitled session';
  return (
    <li className="tv-card tv-session-row">
      <Link to={`/sessions/${session.id}`} className="tv-session-row__main">
        <div className="tv-session-row__title">
          {title}
          {session.hasSidechain ? (
            <span className="tv-chip tv-chip--sidechain" title="Contains subagent/sidechain transcripts">
              sidechain
            </span>
          ) : null}
        </div>
        <div className="tv-session-row__meta tv-muted">
          <span title={formatDateTime(session.startedAt)}>{timeAgo(session.endedAt || session.startedAt)}</span>
          <span>·</span>
          <span>{session.messageCount} msgs</span>
          <span>·</span>
          <span>{session.toolCallCount} tools</span>
          {session.gitBranch ? (
            <>
              <span>·</span>
              <span className="tv-mono" title="git branch">
                ⎇ {session.gitBranch}
              </span>
            </>
          ) : null}
          <span>·</span>
          <span>{formatBytes(session.sizeBytes)}</span>
        </div>
      </Link>
      <div className="tv-session-row__side">
        <div className="tv-chips">
          <AgentBadge connectorId={session.connectorId} />
          {session.models.map((m) => (
            <span key={m} className="tv-chip tv-chip--model">
              {shortModel(m)}
            </span>
          ))}
        </div>
        <div className="tv-session-row__numbers">
          <TokenChips totalOnly total={session.totalTokens} />
          <CostBadge usd={session.totalCostUsd} />
        </div>
        {session.prUrl ? (
          <a
            href={session.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="tv-chip tv-chip--pr"
            onClick={(e) => e.stopPropagation()}
          >
            PR ↗
          </a>
        ) : null}
      </div>
    </li>
  );
}
