import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { SessionDetailResponse, SubagentRun } from '@claudescope/shared';
import { api, ApiError } from '../../api/client.js';
import { CostBadge, ErrorBox, Spinner, TokenChips } from '../../components';
import { formatBytes, formatDateTime, shortModel } from '../browse/format.js';
import { hasRenderableContent } from './blocks.js';
import { SubagentBlock, SubagentJumpMenu, ThreadList, useHashTarget } from './ThreadView.js';
import { ChangesetPanel } from './ChangesetPanel.js';
import { buildChangeset } from './changeset.js';
import { ExportMenu } from './ExportMenu.js';
import { SessionSearchContext } from './SearchContext.js';
import { buildMatches, revealForMatch, type RoleFilter } from './search.js';
import { SessionFinder } from './SessionFinder.js';
import { highlightMatchInBlock, clearHighlights } from './finderDom.js';
import './session.css';

/**
 * Session reader. Fetches the assembled thread for `:id` and renders an ordered
 * conversation of user/assistant turns. A sticky header carries the title +
 * aggregate meta; each turn is anchored by message uuid so search deep-links
 * (`/sessions/:id#<uuid>`) can scroll to a specific message.
 */
export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<SessionDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    api
      .getSession(id, controller.signal)
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof ApiError && err.status === 0) return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, [id, reloadKey]);

  // Scroll to the #<uuid> anchor once the thread has rendered (deep-link).
  useEffect(() => {
    if (!data) return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('is-targeted');
      const timer = window.setTimeout(() => el.classList.remove('is-targeted'), 2400);
      return () => window.clearTimeout(timer);
    }
  }, [data]);

  if (!id) return <ErrorBox error="Missing session id" />;
  if (loading) return <Spinner size="lg" label="Loading session…" />;
  if (error) return <ErrorBox error={error} onRetry={() => setReloadKey((k) => k + 1)} />;
  if (!data) return null;

  return <SessionView data={data} />;
}

function SessionView({ data }: { data: SessionDetailResponse }) {
  const { meta, thread, subagents } = data;
  const title = meta.title || 'Untitled session';
  const hashTarget = useHashTarget();
  const [searchParams] = useSearchParams();

  // Only render turns that actually carry visible content.
  const items = useMemo(() => thread.filter((t) => hasRenderableContent(t.blocks)), [thread]);

  // Subagents linked to a spawn point render nested at that tool call (a single
  // Workflow call fans out to many); any that couldn't be matched are listed in
  // an "Other subagents" section at the end.
  const subagentsByToolUseId = useMemo(() => {
    const map = new Map<string, SubagentRun[]>();
    for (const s of subagents) {
      if (!s.toolUseId) continue;
      const list = map.get(s.toolUseId);
      if (list) list.push(s);
      else map.set(s.toolUseId, [s]);
    }
    // Order co-located runs by when they started (first turn timestamp).
    for (const list of map.values()) {
      list.sort((a, b) => (a.thread[0]?.timestamp ?? '').localeCompare(b.thread[0]?.timestamp ?? ''));
    }
    return map;
  }, [subagents]);
  const orphanSubagents = useMemo(() => subagents.filter((s) => !s.toolUseId), [subagents]);

  // Cheap (no diffing): just groups edits by file, for the tab count.
  const changes = useMemo(() => buildChangeset(thread, subagents), [thread, subagents]);
  const [tab, setTab] = useState<'conversation' | 'changes'>(() =>
    searchParams.get('tab') === 'changes' && changes.length > 0 ? 'changes' : 'conversation',
  );

  // ── In-session finder ────────────────────────────────────────────────────
  // Initialize from a `?find=` deep-link (e.g. from a global search result).
  const [query, setQuery] = useState(() => searchParams.get('find') ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [activeIndex, setActiveIndex] = useState(0);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce the query and require >= 2 chars, so rapid typing (or a 1-char
  // query that matches everything) never triggers heavy work on every keystroke.
  useEffect(() => {
    const t = window.setTimeout(
      () => setDebouncedQuery(query.trim().length >= 2 ? query.trim() : ''),
      200,
    );
    return () => window.clearTimeout(t);
  }, [query]);

  // Ordered match list, computed from data (collapsed content included).
  const matches = useMemo(
    () => buildMatches(thread, subagents, subagentsByToolUseId, debouncedQuery, roleFilter),
    [thread, subagents, subagentsByToolUseId, debouncedQuery, roleFilter],
  );
  const count = matches.length;

  // Reset to the first match whenever the result set changes.
  useEffect(() => setActiveIndex(0), [matches]);

  // Reveal ONLY the active match's block/subagent — never all of them.
  const activeMatch = count > 0 ? matches[Math.min(activeIndex, count - 1)] : undefined;
  const reveal = useMemo(() => revealForMatch(activeMatch), [activeMatch]);

  // Highlight the active match within its (now-revealed) block. Scoped to one
  // block, so it stays cheap. Re-run on a short delay to catch async code blocks.
  useEffect(() => {
    const container = threadRef.current;
    clearHighlights();
    if (!container || !activeMatch) return;
    const run = () => highlightMatchInBlock(container, activeMatch, debouncedQuery);
    run();
    const t = window.setTimeout(run, 200);
    return () => window.clearTimeout(t);
  }, [activeMatch, debouncedQuery]);

  // Clear highlights when leaving the session.
  useEffect(() => clearHighlights, []);

  // Cmd/Ctrl+F focuses the finder instead of the browser's find.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const step = (delta: number) => {
    setActiveIndex((i) => (count === 0 ? 0 : (i + delta + count) % count));
  };

  return (
    <div className="tv-session">
      <header className="tv-session__header">
        <div className="tv-session__crumbs">
          <Link to="/" className="tv-linkbtn">
            ← Browse
          </Link>
          <SubagentJumpMenu subagents={subagents} />
          <ExportMenu data={data} />
          <SessionFinder
            query={query}
            onQuery={setQuery}
            roleFilter={roleFilter}
            onRoleFilter={setRoleFilter}
            count={count}
            activeIndex={activeIndex}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
            inputRef={inputRef}
          />
        </div>
        <h1 className="tv-session__title" title={title}>
          {title}
          {meta.hasSidechain ? (
            <span className="tv-chip tv-chip--sidechain" title="Includes subagent/sidechain transcripts">
              {subagents.length} subagent{subagents.length === 1 ? '' : 's'}
            </span>
          ) : null}
        </h1>
        <div className="tv-session__meta">
          <span className="tv-muted">{formatDateTime(meta.startedAt)}</span>
          <span className="tv-muted">→ {formatDateTime(meta.endedAt)}</span>
          <span className="tv-muted">{meta.messageCount} msgs</span>
          <span className="tv-muted">{meta.toolCallCount} tools</span>
          {meta.gitBranch ? <span className="tv-mono tv-muted">⎇ {meta.gitBranch}</span> : null}
          <span className="tv-muted">{formatBytes(meta.sizeBytes)}</span>
          <span className="tv-chips">
            {meta.models.map((m) => (
              <span key={m} className="tv-chip tv-chip--model">
                {shortModel(m)}
              </span>
            ))}
          </span>
          <TokenChips totalOnly total={meta.totalTokens} />
          <CostBadge usd={meta.totalCostUsd} />
          {meta.prUrl ? (
            <a
              href={meta.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="tv-chip tv-chip--pr"
            >
              PR ↗
            </a>
          ) : null}
        </div>
      </header>

      {changes.length > 0 ? (
        <div className="tv-session__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'conversation'}
            className={tab === 'conversation' ? 'tv-tab is-active' : 'tv-tab'}
            onClick={() => setTab('conversation')}
          >
            Conversation
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'changes'}
            className={tab === 'changes' ? 'tv-tab is-active' : 'tv-tab'}
            onClick={() => setTab('changes')}
          >
            Files changed <span className="tv-tab__count">{changes.length}</span>
          </button>
        </div>
      ) : null}

      {/* Both views stay mounted; we only toggle visibility so switching tabs
          never re-renders the (potentially huge) conversation thread. */}
      <SessionSearchContext.Provider value={reveal}>
        <div
          className="tv-session__thread"
          ref={threadRef}
          style={tab === 'conversation' ? undefined : { display: 'none' }}
        >
          {items.length === 0 ? (
            <p className="tv-muted">This session has no renderable messages.</p>
          ) : (
            <ThreadList
              items={items}
              subagentsByToolUseId={subagentsByToolUseId}
              hashTarget={hashTarget}
            />
          )}

          {orphanSubagents.length > 0 ? (
            <section className="tv-session__orphans">
              <h2 className="tv-session__orphans-title">
                Other subagents
                <span className="tv-muted"> (not linked to a tool call)</span>
              </h2>
              {orphanSubagents.map((run) => (
                <SubagentBlock key={run.agentId} run={run} hashTarget={hashTarget} />
              ))}
            </section>
          ) : null}
        </div>
      </SessionSearchContext.Provider>

      {changes.length > 0 ? (
        <div
          className="tv-session__changes"
          style={tab === 'changes' ? undefined : { display: 'none' }}
        >
          <ChangesetPanel changes={changes} />
        </div>
      ) : null}
    </div>
  );
}
