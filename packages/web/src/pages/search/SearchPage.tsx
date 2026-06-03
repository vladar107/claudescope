/**
 * Full-text search view (/search).
 *
 * Drives the FTS-backed `/api/search` endpoint with a debounced query box plus
 * project and role/type filters. Results are BM25-ranked and carry server-built
 * HTML snippets with `<mark>` highlights (rendered via dangerouslySetInnerHTML —
 * the server HTML-escapes everything but the marks). Each hit deep-links to the
 * session thread at the matching message anchor: `/sessions/:id#<messageUuid>`.
 *
 * Query state lives in the URL (?q=&project=&type=) so searches are shareable
 * and survive reloads.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  ProjectMeta,
  SearchResult,
  SearchType,
} from '@claudescope/shared';
import { api, ApiError } from '../../api/client.js';
import { ErrorBox, Spinner } from '../../components';
import './search.css';

/** Debounce delay (ms) before firing a search after the query box settles. */
const SEARCH_DEBOUNCE_MS = 300;

const TYPE_OPTIONS: ReadonlyArray<{ value: SearchType; label: string }> = [
  { value: 'all', label: 'All roles' },
  { value: 'user', label: 'User' },
  { value: 'assistant', label: 'Assistant' },
];

/** Narrow an arbitrary string to a valid SearchType, defaulting to 'all'. */
function asSearchType(value: string | null): SearchType {
  return value === 'user' || value === 'assistant' ? value : 'all';
}

/** CSS modifier class for a result's role pill. */
function roleClass(role: string): string {
  if (role === 'user') return 'tv-search__role tv-search__role--user';
  if (role === 'assistant') return 'tv-search__role tv-search__role--assistant';
  return 'tv-search__role';
}

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Derive controlled inputs from the URL (single source of truth).
  const query = searchParams.get('q') ?? '';
  const project = searchParams.get('project') ?? '';
  const type = asSearchType(searchParams.get('type'));

  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** True once at least one search has resolved for the current query. */
  const [searched, setSearched] = useState(false);

  const [projects, setProjects] = useState<ProjectMeta[]>([]);

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
      setResults([]);
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
        .search({ q: trimmed, project: project || undefined, type }, controller.signal)
        .then((hits) => {
          setResults(hits);
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
  }, [query, project, type]);

  const hasQuery = query.trim() !== '';

  const projectOptions = useMemo(
    () => [...projects].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [projects],
  );

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
      </div>

      {error ? (
        <ErrorBox error={error} title="Search failed" onRetry={() => patchParams({ q: query })} />
      ) : loading ? (
        <Spinner label="Searching…" />
      ) : !hasQuery ? (
        <p className="tv-search__empty">Type a query above to search across all transcripts.</p>
      ) : searched && results.length === 0 ? (
        <p className="tv-search__empty">
          No matches for <strong>{query}</strong>
          {project ? ' in this project' : ''}.
        </p>
      ) : (
        <>
          <div className="tv-search__meta">
            {results.length} result{results.length === 1 ? '' : 's'}
            {results.length >= 50 ? ' (showing top 50)' : ''}
          </div>
          <div className="tv-search__results">
            {results.map((r) => (
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
        </>
      )}
    </div>
  );
}
