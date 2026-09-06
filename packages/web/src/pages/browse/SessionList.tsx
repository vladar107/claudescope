import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { RotateCcw } from 'lucide-react';
import type { SessionMeta, SessionSort } from '@claudescope/shared';
import { api, ApiError } from '../../api/client.js';
import { AgentBadge, agentLabel, ErrorBox, formatCost, formatCount, LocalBadge, ModelChips, SearchField, Spinner } from '../../components';
import { contextLevel, contextLabel, formatBytes, formatDateTime, timeAgo } from './format.js';
import { useProjectContext } from './ProjectLayout.js';
import { useDataVersionRefetch } from '../../status/useDataVersionRefetch.js';

const SORT_OPTIONS: { value: SessionSort; label: string }[] = [
  { value: 'recent', label: 'Most recent' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'tokens', label: 'Most tokens' },
  { value: 'cost', label: 'Highest cost' },
  { value: 'messages', label: 'Most messages' },
  { value: 'context', label: 'Context' },
];

/** Rows per page — matches the server's own default `limit`. */
const PAGE_SIZE = 50;
/** The server clamps `limit` here; a wide refetch must not ask for more. */
const MAX_LIMIT = 500;
const FILTER_DEBOUNCE_MS = 300;

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
 * Sort, agent filter, and the text filter are all server-driven: the filter is
 * debounced and sent as `q` (matching title / branch / id / model), so it finds
 * sessions beyond the loaded page. The list pages with "Load more".
 */
export function SessionListPage() {
  const { projectId, project } = useProjectContext();

  const [rows, setRows] = useState<SessionMeta[]>([]);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<SessionSort>('recent');
  const [filter, setFilter] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [agent, setAgent] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Typing restarts the wait, so the server sees one query per pause.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(filter.trim()), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filter]);

  // A load-more request in flight when the query changes is stale by then: the
  // first-page effect below owns the result, so cancel it rather than let it
  // append rows from the previous sort/filter.
  const moreRef = useRef<AbortController | null>(null);
  useEffect(() => () => moreRef.current?.abort(), []);

  useEffect(() => {
    moreRef.current?.abort();
    moreRef.current = null;
    const controller = new AbortController();
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setMoreError(null);
    api
      .listSessions(
        {
          project: projectId,
          sort,
          agent,
          q: debouncedQ || undefined,
          limit: PAGE_SIZE,
          offset: 0,
        },
        controller.signal,
      )
      .then((page) => {
        setRows(page.rows);
        setTotal(page.total);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (isBenignError(err)) return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, sort, agent, debouncedQ, reloadKey]);

  function loadMore() {
    moreRef.current?.abort();
    const controller = new AbortController();
    moreRef.current = controller;
    setLoadingMore(true);
    setMoreError(null);
    api
      .listSessions(
        {
          project: projectId,
          sort,
          agent,
          q: debouncedQ || undefined,
          limit: PAGE_SIZE,
          offset: rows.length,
        },
        controller.signal,
      )
      .then((page) => {
        // The index moves under us: a row indexed since the first page can
        // shift a session across the boundary, and a repeated id would collide
        // as a React key.
        setRows((prev) => {
          const seen = new Set(prev.map((s) => s.id));
          return [...prev, ...page.rows.filter((s) => !seen.has(s.id))];
        });
        setTotal(page.total);
        setLoadingMore(false);
      })
      .catch((err: unknown) => {
        if (isBenignError(err)) return;
        setMoreError(err);
        setLoadingMore(false);
      });
  }

  // Steady-state freshness: silently refetch (no spinner, keep scroll) when a
  // reindex pass lands new data — a live session's row updates and new
  // sessions appear without a manual reload. Refetching the whole loaded
  // window (not just the first page) keeps the pages already opened.
  useDataVersionRefetch((signal) => {
    api
      .listSessions(
        {
          project: projectId,
          sort,
          agent,
          q: debouncedQ || undefined,
          limit: Math.min(MAX_LIMIT, Math.max(PAGE_SIZE, rows.length)),
          offset: 0,
        },
        signal,
      )
      .then((page) => {
        setRows(page.rows);
        setTotal(page.total);
      })
      .catch(() => {
        /* transient — the next change retries */
      });
  });

  const agents = project?.agents ?? [];
  const hasMore = rows.length < total;

  return (
    <>
      <div className="tv-browse__controls" style={{ marginBottom: 'var(--tv-space-3)' }}>
        <SearchField
          value={filter}
          onChange={setFilter}
          placeholder="Filter sessions…"
          ariaLabel="Filter sessions"
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

      {loading && rows.length === 0 ? (
        <Spinner size="lg" label="Loading sessions…" />
      ) : error ? (
        <ErrorBox error={error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : rows.length === 0 ? (
        <p className="tv-muted">
          {debouncedQ ? 'No sessions match the filter.' : 'No sessions.'}
        </p>
      ) : (
        <>
          {/* A new sort/filter is in flight: keep the previous rows on screen and
              surface progress as a small indicator instead of blanking them. */}
          <div
            className="tv-muted"
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--tv-space-2)', marginBottom: 'var(--tv-space-3)' }}
          >
            <span>
              {hasMore
                ? `Showing ${rows.length} of ${total} sessions`
                : `${total} session${total === 1 ? '' : 's'}`}
            </span>
            {loading ? <Spinner label="Loading…" /> : null}
          </div>
          <ul className="tv-list">
            {rows.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </ul>
          {moreError ? (
            <div className="tv-browse__more">
              <ErrorBox error={moreError} onRetry={loadMore} />
            </div>
          ) : hasMore ? (
            <div className="tv-browse__more">
              <button
                type="button"
                className="tv-btn tv-btn--secondary"
                onClick={loadMore}
                disabled={loadingMore || loading}
              >
                {loadingMore ? <Spinner label="Loading…" /> : 'Load more'}
              </button>
            </div>
          ) : null}
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
          {session.compactionCount ? (
            <span
              className="tv-chip tv-chip--compaction"
              title={`Context was compacted ${session.compactionCount} time${session.compactionCount === 1 ? '' : 's'}`}
            >
              <RotateCcw size={11} aria-hidden="true" /> {session.compactionCount} compaction
              {session.compactionCount === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
        <div className="tv-session-row__meta tv-muted">
          <span title={formatDateTime(session.startedAt)}>{timeAgo(session.endedAt || session.startedAt)}</span>
          <span>·</span>
          <span>{session.messageCount} msgs</span>
          <span>·</span>
          <span>{session.toolCallCount} tools</span>
          {session.contextTokens !== undefined ? (
            <>
              <span>·</span>
              <ContextMeta tokens={session.contextTokens} contextWindow={session.contextWindow} />
            </>
          ) : null}
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
          {session.hasLocalProvider ? <LocalBadge /> : null}
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

/** `ctx 142K (71%)` — the percent only when pricing knows the model's window. */
function ContextMeta({ tokens, contextWindow }: { tokens: number; contextWindow?: number }) {
  const level = contextLevel(tokens, contextWindow);
  return (
    <span
      className={level ? `tv-ctx tv-ctx--${level}` : 'tv-ctx'}
      title="Context at the last turn (input + cache read + cache write of the last assistant response)"
    >
      context {contextLabel(tokens, contextWindow)}
    </span>
  );
}
