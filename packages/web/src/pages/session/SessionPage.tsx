import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, GitBranch, GitPullRequest, MessageSquare, RefreshCw, Wrench } from 'lucide-react';
import type { SessionDetailResponse, SubagentRun } from '@claudescope/shared';
import { api, ApiError } from '../../api/client.js';
import { AgentBadge, ErrorBox, formatCost, formatCount, LocalBadge, ModelChips, Spinner } from '../../components';
import { formatBytes, formatDateTime, formatDuration } from '../browse/format.js';
import { hasRenderableContent } from './blocks.js';
import { SubagentBlock, SubagentJumpMenu, ThreadList, useHashTarget } from './ThreadView.js';
import { useProgressiveMount } from './useProgressiveMount.js';
import { useScrollRestore } from './useScrollRestore.js';
import { holdBottom, isNearBottom, useLiveSession } from './useLiveSession.js';
import { ChangesetPanel } from './ChangesetPanel.js';
import { buildChangeset } from './changeset.js';
import { ExportMenu } from './ExportMenu.js';
import { ContinueMenu } from './ContinueMenu.js';
import { SessionSearchContext } from './SearchContext.js';
import {
  buildSearchCorpus,
  findMatches,
  revealForMatch,
  type FinderMatch,
  type RoleFilter,
} from './search.js';
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
  const [refreshing, setRefreshing] = useState(false);
  const refreshController = useRef<AbortController | null>(null);

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

  // Cancel any in-flight refresh when the session changes or the page unmounts.
  useEffect(() => () => refreshController.current?.abort(), [id]);

  // Cancels a stick-to-bottom hold when the reader leaves the session mid-hold,
  // so navigating away never keeps pinning the shared app scroller.
  const stickCancelled = useRef(false);
  useEffect(() => {
    stickCancelled.current = false;
    return () => {
      stickCancelled.current = true;
    };
  }, [id]);

  // Soft refresh: re-fetch the thread and swap it in place without unmounting
  // the view, so the scroll position is preserved (turns are keyed by uuid and
  // new turns append at the end). Header `meta` stats may lag until a reindex.
  // `silent` (the live poller) skips the `refreshing` spinner — auto-updates
  // must not flash UI. Resolves true only when new data was swapped in.
  const refresh = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      if (!id || loading || refreshing) return false;
      refreshController.current?.abort();
      const controller = new AbortController();
      refreshController.current = controller;
      if (!opts?.silent) setRefreshing(true);
      try {
        const res = await api.getSession(id, controller.signal);
        // Stick-to-bottom: a reader already at the bottom follows new turns; one
        // scrolled up to read is left untouched (implicit scroll preservation).
        const scroller = document.querySelector('main.tv-main');
        const pin = scroller instanceof HTMLElement && isNearBottom(scroller);
        setData(res);
        if (pin && scroller instanceof HTMLElement) {
          holdBottom(scroller, () => stickCancelled.current);
        }
        return true;
      } catch (err: unknown) {
        if (
          !(err instanceof DOMException && err.name === 'AbortError') &&
          !(err instanceof ApiError && err.status === 0)
        ) {
          // Keep the current content on a failed refresh; just stop the spinner.
          console.error('Session refresh failed', err);
        }
        return false;
      } finally {
        if (!opts?.silent) setRefreshing(false);
      }
    },
    [id, loading, refreshing],
  );

  // ⌘R / Ctrl+R does an in-place soft refresh instead of a full browser reload
  // (which would lose scroll position). ⌘⇧R still falls through to the browser's
  // hard reload as an escape hatch.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        void refresh();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [refresh]);

  // Auto-refresh while the transcript is still being written: poll the cheap
  // fingerprint probe and silently swap new turns in as they land.
  const refreshSilently = useCallback(() => refresh({ silent: true }), [refresh]);
  useLiveSession({ sessionId: id, active: data !== null && !loading, refreshSilently });

  if (!id) return <ErrorBox error="Missing session id" />;
  if (loading) return <Spinner size="lg" label="Loading session…" />;
  if (error) return <ErrorBox error={error} onRetry={() => setReloadKey((k) => k + 1)} />;
  if (!data) return null;

  return <SessionView data={data} onRefresh={() => void refresh()} refreshing={refreshing} />;
}

function SessionView({
  data,
  onRefresh,
  refreshing,
}: {
  data: SessionDetailResponse;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { meta, thread, subagents } = data;
  const title = meta.title || 'Untitled session';
  const duration = formatDuration(meta.startedAt, meta.endedAt);
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

  // Mount turns progressively: the first chunk renders immediately, the rest
  // stream in during idle time, so a huge session never blocks the first paint
  // behind one giant React commit.
  const { visibleItems, allMounted, mounted, ensureMounted, sentinelRef } =
    useProgressiveMount(items);

  // subagentId → uuid of the top-level turn its run renders under. Used to
  // mount the right turn before navigating to a match/anchor inside a nested
  // subagent (orphan runs render after the list and are always mounted).
  const spawnTurnBySubagentId = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      for (const block of item.blocks) {
        if (block.kind !== 'tool') continue;
        for (const run of subagentsByToolUseId.get(block.id) ?? []) map.set(run.agentId, item.uuid);
      }
    }
    return map;
  }, [items, subagentsByToolUseId]);

  // Post-load hash navigation (subagent jump menu, time anchors): the target's
  // turn may not be mounted yet, in which case the native hash scroll (and a
  // nested SubagentBlock's own open-on-hash effect) has nothing to land on —
  // request mounting and let those take over once the element exists.
  const hashTarget = useHashTarget();
  useEffect(() => {
    if (!hashTarget || allMounted) return;
    if (document.getElementById(hashTarget)) return;
    const agentId = hashTarget.startsWith('subagent-')
      ? hashTarget.slice('subagent-'.length)
      : undefined;
    const target = agentId ? spawnTurnBySubagentId.get(agentId) : hashTarget;
    if (target) ensureMounted(target);
  }, [hashTarget, allMounted, mounted, spawnTurnBySubagentId, ensureMounted]);

  // Scroll to the #<anchor> deep-link once its turn is mounted. Only on the
  // first load for a given session — a soft refresh swaps `data` but must not
  // yank a deep-linked reader away from their place.
  const hashScrolledForId = useRef<string | null>(null);
  useEffect(() => {
    if (hashScrolledForId.current === meta.id) return;
    const hash = window.location.hash.slice(1);
    if (!hash) {
      hashScrolledForId.current = meta.id;
      return;
    }
    const el = document.getElementById(hash);
    if (!el) {
      // Target not in the DOM yet: request its turn and retry as turns mount.
      if (allMounted) {
        hashScrolledForId.current = meta.id; // never going to appear — give up
        return;
      }
      const agentId = hash.startsWith('subagent-') ? hash.slice('subagent-'.length) : undefined;
      const target = agentId ? spawnTurnBySubagentId.get(agentId) : hash;
      if (target) ensureMounted(target);
      return;
    }
    hashScrolledForId.current = meta.id;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('is-targeted');
    // Fire-and-forget: this effect re-runs as idle mounting grows `mounted`,
    // so a cleanup-managed timer would be cleared before it fires and leave
    // the highlight stuck on. Removing a class on a detached node is harmless.
    window.setTimeout(() => el.classList.remove('is-targeted'), 2400);
  }, [meta.id, mounted, allMounted, spawnTurnBySubagentId, ensureMounted]);

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

  // Safari can't intercept ⌘R (see the keydown handler above), so a full
  // reload there — or a hard reload anywhere — restores the reader's place.
  useScrollRestore({ sessionId: meta.id, items, mounted, allMounted, ensureMounted, threadRef });

  // Debounce the query and require >= 2 chars, so rapid typing (or a 1-char
  // query that matches everything) never triggers heavy work on every keystroke.
  useEffect(() => {
    const t = window.setTimeout(
      () => setDebouncedQuery(query.trim().length >= 2 ? query.trim() : ''),
      200,
    );
    return () => window.clearTimeout(t);
  }, [query]);

  // Searchable corpus, built lazily on the first non-empty query (readers who
  // never search pay nothing) and kept until the query clears or `data` swaps.
  // Query/filter changes then only re-run the cheap string scan below.
  const searching = debouncedQuery.length > 0;
  const corpus = useMemo(
    () => (searching ? buildSearchCorpus(thread, subagents, subagentsByToolUseId) : null),
    [searching, thread, subagents, subagentsByToolUseId],
  );

  // Ordered match list, computed from data (collapsed content included).
  const matches = useMemo(
    () => (corpus ? findMatches(corpus, debouncedQuery, roleFilter) : []),
    [corpus, debouncedQuery, roleFilter],
  );
  const count = matches.length;

  // Reset to the first match whenever the result set changes.
  useEffect(() => setActiveIndex(0), [matches]);

  // Reveal ONLY the active match's block/subagent — never all of them.
  const activeMatch = count > 0 ? matches[Math.min(activeIndex, count - 1)] : undefined;
  const reveal = useMemo(() => revealForMatch(activeMatch), [activeMatch]);

  // Highlight the active match within its (now-revealed) block. Scoped to one
  // block, so it stays cheap. Re-run on a short delay to catch async code
  // blocks, and on `mounted` growth in case the match's turn wasn't in the
  // DOM yet (progressive mounting). Once highlighted, later `mounted` growth
  // must NOT re-run it — highlightMatchInBlock scrolls to the match, and
  // re-running per idle tick would keep yanking the reader back to it.
  const highlighted = useRef<{ match: FinderMatch; query: string } | null>(null);
  useEffect(() => {
    const done = highlighted.current;
    if (done && done.match === activeMatch && done.query === debouncedQuery) return;
    const container = threadRef.current;
    clearHighlights();
    highlighted.current = null;
    if (!container || !activeMatch) return;
    const anchorUuid = activeMatch.subagentId
      ? spawnTurnBySubagentId.get(activeMatch.subagentId) // undefined → orphan section, always mounted
      : activeMatch.turnUuid;
    if (anchorUuid) ensureMounted(anchorUuid);
    const run = () => {
      if (highlightMatchInBlock(container, activeMatch, debouncedQuery)) {
        highlighted.current = { match: activeMatch, query: debouncedQuery };
      }
    };
    run();
    const t = window.setTimeout(run, 200);
    return () => window.clearTimeout(t);
  }, [activeMatch, debouncedQuery, mounted, spawnTurnBySubagentId, ensureMounted]);

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

  // Memoize the (expensive) thread subtree so switching tabs — which only
  // changes `tab` — doesn't re-render hundreds of turns / re-parse markdown.
  // It recomputes only when the data or the finder's reveal actually change
  // (and Turn/ThreadBlockView are memoized, so even then most turns bail out).
  const threadView = useMemo(
    () => (
      <SessionSearchContext.Provider value={reveal}>
        <div className="tv-session__thread" ref={threadRef}>
          {items.length > 0 ? (
            <div className="tv-token-legend" aria-hidden="true">
              <span className="tv-token-legend__label">Tokens</span>
              <span className="tv-token-legend__item">
                <span className="tv-token-legend__dot tv-token-legend__dot--in" /> input
              </span>
              <span className="tv-token-legend__item">
                <span className="tv-token-legend__dot tv-token-legend__dot--out" /> output
              </span>
              <span className="tv-token-legend__item">
                <span className="tv-token-legend__dot tv-token-legend__dot--cache" /> cache read · write
              </span>
            </div>
          ) : null}
          {items.length === 0 ? (
            <p className="tv-muted">This session has no renderable messages.</p>
          ) : (
            <ThreadList items={visibleItems} subagentsByToolUseId={subagentsByToolUseId} />
          )}
          {allMounted ? null : (
            <p className="tv-muted" ref={sentinelRef}>
              Rendering {items.length - visibleItems.length} more turns…
            </p>
          )}

          {orphanSubagents.length > 0 ? (
            <section className="tv-session__orphans">
              <h2 className="tv-session__orphans-title">
                Other subagents
                <span className="tv-muted"> (not linked to a tool call)</span>
              </h2>
              {orphanSubagents.map((run) => (
                <SubagentBlock key={run.agentId} run={run} />
              ))}
            </section>
          ) : null}
        </div>
      </SessionSearchContext.Provider>
    ),
    [reveal, items, visibleItems, allMounted, subagentsByToolUseId, orphanSubagents, sentinelRef],
  );

  return (
    <div className="tv-session">
      <header className="tv-session__header">
        <div className="tv-session__crumbs">
          <nav className="tv-session__trail" aria-label="Breadcrumb">
            <Link to="/" className="tv-linkbtn">
              ← Projects
            </Link>
            {meta.projectId ? (
              <>
                <span className="tv-muted"> / </span>
                <Link
                  to={`/projects/${meta.projectId}`}
                  className="tv-linkbtn tv-mono"
                  title={`All ${meta.projectDisplayName || 'project'} sessions`}
                >
                  {meta.projectDisplayName || 'project'}
                </Link>
              </>
            ) : null}
          </nav>
          <SubagentJumpMenu subagents={subagents} />
          {data.resume ? (
            <ContinueMenu
              resume={data.resume}
              connectorId={meta.connectorId}
              projectName={meta.projectDisplayName}
              branch={meta.gitBranch}
            />
          ) : null}
          <ExportMenu data={data} />
          <button
            type="button"
            className="tv-session__action"
            onClick={onRefresh}
            disabled={refreshing}
            title="Reload the latest messages without losing your place (⌘R)"
          >
            {refreshing ? (
              <Spinner size="sm" label="Refreshing…" />
            ) : (
              <>
                <RefreshCw size={14} aria-hidden="true" /> Refresh
              </>
            )}
          </button>
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

        {/* Tier one: the title, with the PR action promoted to the right. */}
        <div className="tv-session__titlebar">
          <h1 className="tv-session__title" title={title}>
            {title}
            {meta.titleDerived ? (
              <span
                className="tv-chip tv-session__derived"
                title="No stored title — derived from the first message"
              >
                untitled · from first message
              </span>
            ) : null}
            {meta.hasSidechain ? (
              <span className="tv-chip tv-chip--sidechain" title="Includes subagent/sidechain transcripts">
                {subagents.length} subagent{subagents.length === 1 ? '' : 's'}
              </span>
            ) : null}
          </h1>
          {meta.prUrl ? (
            <a
              href={meta.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="tv-session__pr-btn"
            >
              <GitPullRequest size={14} aria-hidden="true" /> PR
              <ArrowUpRight size={12} aria-hidden="true" />
            </a>
          ) : null}
        </div>

        {/* Tier one stats: agent + models, then cost (the bold figure) + tokens + duration. */}
        <div className="tv-session__primary">
          <AgentBadge connectorId={meta.connectorId} />
          <ModelChips models={meta.models} />
          {meta.hasLocalProvider ? <LocalBadge /> : null}
          <span className="tv-session__sep" aria-hidden="true">
            │
          </span>
          <span className="tv-session__cost">{formatCost(meta.totalCostUsd)}</span>
          <span className="tv-session__tokens">{formatCount(meta.totalTokens)} tokens</span>
          {duration ? <span className="tv-muted">{duration}</span> : null}
        </div>

        {/* Tier two: counts, branch, timestamps, size — present, not loud. */}
        <div className="tv-session__meta tv-muted">
          <span className="tv-session__meta-item">
            <MessageSquare size={13} aria-hidden="true" /> {meta.messageCount} messages
          </span>
          <span className="tv-session__meta-item">
            <Wrench size={13} aria-hidden="true" /> {meta.toolCallCount} tools
          </span>
          {meta.gitBranch ? (
            <span className="tv-session__meta-item tv-mono" title="git branch">
              <GitBranch size={13} aria-hidden="true" /> {meta.gitBranch}
            </span>
          ) : null}
          <span>
            {formatDateTime(meta.startedAt)} → {formatDateTime(meta.endedAt)}
          </span>
          <span>{formatBytes(meta.sizeBytes)}</span>
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

      {/* Both views stay mounted; we toggle visibility (the thread element is
          memoized above, so switching tabs doesn't re-render it). */}
      <div style={tab === 'conversation' ? undefined : { display: 'none' }}>{threadView}</div>

      {changes.length > 0 ? (
        <div
          className="tv-session__changes"
          style={tab === 'changes' ? undefined : { display: 'none' }}
        >
          <ChangesetPanel changes={changes} active={tab === 'changes'} />
        </div>
      ) : null}
    </div>
  );
}
