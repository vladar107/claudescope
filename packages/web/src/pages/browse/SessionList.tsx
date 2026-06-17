import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SessionMeta, SessionSort } from '@claudescope/shared';
import { api, ApiError } from '../../api/client.js';
import { AgentBadge, agentLabel, ErrorBox, formatCost, formatCount, ModelChips, Spinner } from '../../components';
import { formatBytes, formatDateTime, timeAgo } from './format.js';
import { useProjectContext } from './ProjectLayout.js';

const SORT_OPTIONS: { value: SessionSort; label: string }[] = [
  { value: 'recent', label: 'Most recent' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'tokens', label: 'Most tokens' },
  { value: 'cost', label: 'Highest cost' },
  { value: 'messages', label: 'Most messages' },
];

/** Ignore aborted/offline fetch errors that are not user-actionable. */
function isBenignError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof ApiError && err.status === 0) return true;
  return false;
}

/**
 * The Sessions tab of a project (`/projects/:projectId`). The breadcrumb, name,
 * cwd, and the Sessions | Memory tab bar live in {@link ProjectLayout}; this
 * renders the tab body — sort/filter controls, the agent filter, and the list.
 * Sort and agent filter are server-driven (re-fetch on change); the text filter
 * is applied client-side against title / branch / id.
 */
export function SessionListPage() {
  const { projectId, project } = useProjectContext();

  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sort, setSort] = useState<SessionSort>('recent');
  const [filter, setFilter] = useState('');
  const [agent, setAgent] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .listSessions({ project: projectId, sort, agent }, controller.signal)
      .then((data) => {
        setSessions(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (isBenignError(err)) return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, sort, agent, reloadKey]);

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

  const agents = project?.agents ?? [];

  return (
    <>
      <div className="tv-browse__controls" style={{ marginBottom: 'var(--tv-space-3)' }}>
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

      {/* Agent filter — only meaningful when the project spans 2+ agents. */}
      {agents.length > 1 ? (
        <div className="tv-agent-filter" role="group" aria-label="Filter by agent">
          <button
            type="button"
            className={agent === undefined ? 'tv-agent-filter__btn is-active' : 'tv-agent-filter__btn'}
            onClick={() => setAgent(undefined)}
          >
            All
          </button>
          {agents.map((a) => (
            <button
              key={a.connectorId}
              type="button"
              className={
                agent === a.connectorId ? 'tv-agent-filter__btn is-active' : 'tv-agent-filter__btn'
              }
              onClick={() => setAgent(a.connectorId)}
            >
              {agentLabel(a.connectorId)}
              <span className="tv-agent-filter__count">{a.sessionCount}</span>
            </button>
          ))}
        </div>
      ) : null}

      {loading ? (
        <Spinner size="lg" label="Loading sessions…" />
      ) : error ? (
        <ErrorBox error={error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : filtered.length === 0 ? (
        <p className="tv-muted">
          {sessions.length === 0 ? 'No sessions.' : 'No sessions match the filter.'}
        </p>
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
    </>
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
        {/* One tidy meta line: agent + models, then the numbers with cost bold. */}
        <div className="tv-session-row__meta-line">
          <AgentBadge connectorId={session.connectorId} />
          <ModelChips models={session.models} />
          <span className="tv-session-row__sep" aria-hidden="true">
            │
          </span>
          <span className="tv-session-row__tokens tv-muted">
            {formatCount(session.totalTokens)}
          </span>
          <span className="tv-session-row__cost">{formatCost(session.totalCostUsd)}</span>
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
