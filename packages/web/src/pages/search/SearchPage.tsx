/**
 * Full-text search view (/search).
 *
 * Drives the FTS-backed `/api/search` endpoint with a debounced query box plus
 * project, role/type, and scope filters. Results are BM25-ranked and carry
 * server-built HTML snippets with `<mark>` highlights (rendered via
 * dangerouslySetInnerHTML — the server HTML-escapes everything but the marks).
 * Session hits deep-link to the thread at the matching message anchor
 * (`/sessions/:id#<messageUuid>`); memory hits link to the relevant memory view.
 *
 * The scope control selects where search looks: transcripts only (`sessions`,
 * the default), transcripts plus agent memory (`all`), or memory only (`memory`).
 *
 * Query state lives in the URL (?q=&project=&type=&scope=) so searches are
 * shareable and survive reloads.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  MemorySearchHit,
  ProjectMeta,
  SearchResult,
  SearchScope,
  SearchType,
} from '@claudescope/shared';
import { api, ApiError } from '../../api/client.js';
import { AgentBadge, ErrorBox, Spinner } from '../../components';
import './search.css';

/** Debounce delay (ms) before firing a search after the query box settles. */
const SEARCH_DEBOUNCE_MS = 300;

const TYPE_OPTIONS: ReadonlyArray<{ value: SearchType; label: string }> = [
  { value: 'all', label: 'All roles' },
  { value: 'user', label: 'User' },
  { value: 'assistant', label: 'Assistant' },
];

const SCOPE_OPTIONS: ReadonlyArray<{ value: SearchScope; label: string }> = [
  { value: 'sessions', label: 'Without memory' },
  { value: 'all', label: 'Including memory' },
  { value: 'memory', label: 'Memory only' },
];

/** Narrow an arbitrary string to a valid SearchType, defaulting to 'all'. */
function asSearchType(value: string | null): SearchType {
  return value === 'user' || value === 'assistant' ? value : 'all';
}

/** Narrow an arbitrary string to a valid SearchScope, defaulting to 'sessions'. */
function asSearchScope(value: string | null): SearchScope {
  return value === 'all' || value === 'memory' ? value : 'sessions';
}

/** CSS modifier class for a result's role pill. */
function roleClass(role: string): string {
  if (role === 'user') return 'tv-search__role tv-search__role--user';
  if (role === 'assistant') return 'tv-search__role tv-search__role--assistant';
  return 'tv-search__role';
}

/** Memory view route for a hit: project facts deep-link, globals to the agent. */
function memoryLink(hit: MemorySearchHit): string {
  if (hit.scope === 'project' && hit.projectId) {
    return `/memory/${encodeURIComponent(hit.connectorId)}/${encodeURIComponent(hit.projectId)}`;
  }
  return `/memory/${encodeURIComponent(hit.connectorId)}`;
}

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive controlled inputs from the URL (single source of truth).
  const query = searchParams.get('q') ?? '';
  const project = searchParams.get('project') ?? '';
  const type = asSearchType(searchParams.get('type'));
  const scope = asSearchScope(searchParams.get('scope'));

  const [sessions, setSessions] = useState<SearchResult[]>([]);
  const [memory, setMemory] = useState<MemorySearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** True once at least one search has resolved for the current query. */
  const [searched, setSearched] = useState(false);

  const [projects, setProjects] = useState<ProjectMeta[]>([]);

  // The role filter only applies to session transcripts; hide it for memory-only.
  const showRoleFilter = scope !== 'memory';

  /** Update one or more URL params, dropping empties to keep the URL clean. */
  function patchParams(patch: Record<string, string>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next, { replace: true });
  }

  // Load the project list once for the filter dropdown. A failure here is
  // non-fatal — search still works without the project filter populated.
  useEffect(() => {
    const controller = new AbortController();
    api
      .listProjects(controller.signal)
      .then(setProjects)
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          // Filter is a convenience; swallow the error rather than blocking search.
          console.warn('Failed to load projects for search filter', err);
        }
      });
    return () => controller.abort();
  }, []);

  // Track the latest debounce timer so filter changes restart the wait.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Run the search whenever the query or filters change (debounced + cancelable).
  useEffect(() => {
    const trimmed = query.trim();

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (trimmed === '') {
      setSessions([]);
      setMemory([]);
      setLoading(false);
      setError(null);
      setSearched(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    debounceRef.current = setTimeout(() => {
      api
        .search(
          { q: trimmed, project: project || undefined, type, scope },
          controller.signal,
        )
        .then((res) => {
          setSessions(res.sessions);
          setMemory(res.memory);
          setSearched(true);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          if (err instanceof ApiError && err.status === 0) return;
          setError(err);
          setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      controller.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, project, type, scope]);

  const hasQuery = query.trim() !== '';

  const projectOptions = useMemo(
    () => [...projects].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [projects],
  );

  // The active scope decides which sections are visible and what the count means.
  const showSessions = scope !== 'memory';
  const showMemory = scope !== 'sessions';
  const totalCount =
    (showSessions ? sessions.length : 0) + (showMemory ? memory.length : 0);

  return (
    <div className="tv-search">
      <h1 className="tv-page-title">Search</h1>

      <div className="tv-search__controls">
        <div className="tv-search__field tv-search__field--grow">
          <label className="tv-search__label" htmlFor="tv-search-q">
            Query
          </label>
          <input
            id="tv-search-q"
            className="tv-search__input"
            type="search"
            placeholder="Search transcripts…"
            value={query}
            autoFocus
            onChange={(e) => patchParams({ q: e.target.value })}
          />
        </div>

        <div className="tv-search__field">
          <label className="tv-search__label" htmlFor="tv-search-project">
            Project
          </label>
          <select
            id="tv-search-project"
            className="tv-search__select"
            value={project}
            onChange={(e) => patchParams({ project: e.target.value })}
          >
            <option value="">All projects</option>
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="tv-search__field">
          <label className="tv-search__label" htmlFor="tv-search-scope">
            Scope
          </label>
          <select
            id="tv-search-scope"
            className="tv-search__select"
            value={scope}
            onChange={(e) => patchParams({ scope: e.target.value })}
          >
            {SCOPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {showRoleFilter ? (
          <div className="tv-search__field">
            <label className="tv-search__label" htmlFor="tv-search-type">
              Role
            </label>
            <select
              id="tv-search-type"
              className="tv-search__select"
              value={type}
              onChange={(e) => patchParams({ type: e.target.value })}
            >
              {TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {error ? (
        <ErrorBox error={error} title="Search failed" onRetry={() => patchParams({ q: query })} />
      ) : loading ? (
        <Spinner label="Searching…" />
      ) : !hasQuery ? (
        <p className="tv-search__empty">Type a query above to search across all transcripts.</p>
      ) : searched && totalCount === 0 ? (
        <p className="tv-search__empty">
          No matches for <strong>{query}</strong>
          {project ? ' in this project' : ''}.
        </p>
      ) : (
        <>
          <div className="tv-search__meta">
            {totalCount} result{totalCount === 1 ? '' : 's'}
          </div>

          {showSessions && sessions.length > 0 ? (
            <section className="tv-search__section">
              <h2 className="tv-search__section-title">Sessions ({sessions.length})</h2>
              <div className="tv-search__results">
                {sessions.map((r) => (
                  <Link
                    key={`${r.sessionId}:${r.messageUuid}`}
                    to={`/sessions/${encodeURIComponent(r.sessionId)}#${encodeURIComponent(r.messageUuid)}`}
                    className="tv-card tv-search__result"
                  >
                    <div className="tv-search__result-head">
                      <span
                        className={
                          r.title
                            ? 'tv-search__result-title'
                            : 'tv-search__result-title tv-search__result-title--untitled'
                        }
                      >
                        {r.title || 'Untitled session'}
                      </span>
                      {r.role ? <span className={roleClass(r.role)}>{r.role}</span> : null}
                      <span className="tv-search__score">score {r.score.toFixed(2)}</span>
                    </div>
                    <div
                      className="tv-search__snippet"
                      // Server snippet is HTML-escaped except <mark> wraps (safe).
                      dangerouslySetInnerHTML={{ __html: r.snippet }}
                    />
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          {showMemory && memory.length > 0 ? (
            <section className="tv-search__section">
              <h2 className="tv-search__section-title">Memory ({memory.length})</h2>
              <div className="tv-search__results">
                {memory.map((hit, i) => (
                  <Link
                    key={`${hit.connectorId}:${hit.sourcePath}:${i}`}
                    to={memoryLink(hit)}
                    className="tv-card tv-search__result"
                  >
                    <div className="tv-search__result-head">
                      <AgentBadge connectorId={hit.connectorId} />
                      <span className="tv-chip tv-search__mem-scope">
                        {hit.scope === 'project' ? 'Project' : 'Global'}
                        {hit.category ? ` · ${hit.category}` : ''}
                      </span>
                      <span className="tv-search__result-title">{hit.title}</span>
                      {hit.projectDisplayName ? (
                        <span className="tv-search__mem-project">{hit.projectDisplayName}</span>
                      ) : null}
                    </div>
                    <div
                      className="tv-search__snippet"
                      // Server snippet is HTML-escaped except <mark> wraps (safe).
                      dangerouslySetInnerHTML={{ __html: hit.snippet }}
                    />
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
