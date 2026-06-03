import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { SessionDetailResponse, SubagentRun } from '@claudescope/shared';
import { api, ApiError } from '../../api/client.js';
import { CostBadge, ErrorBox, Spinner, TokenChips } from '../../components';
import { formatBytes, formatDateTime, shortModel } from '../browse/format.js';
import { hasRenderableContent } from './blocks.js';
import { SubagentBlock, SubagentJumpMenu, ThreadList, useHashTarget } from './ThreadView.js';
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

  return (
    <div className="tv-session">
      <header className="tv-session__header">
        <div className="tv-session__crumbs">
          <Link to="/" className="tv-linkbtn">
            ← Browse
          </Link>
          <SubagentJumpMenu subagents={subagents} />
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

      <div className="tv-session__thread">
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
    </div>
  );
}
