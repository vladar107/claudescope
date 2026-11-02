import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { LIVE_WINDOW_MINUTES, type LiveResponse, type LiveSession, type LiveState } from '@claudescope/shared';
import { api } from '../../api/client.js';
import { AgentBadge, ErrorBox, formatCost, formatCount, Spinner } from '../../components';
import { useServerStatus } from '../../status/StatusProvider.js';
import { useDataVersionRefetch } from '../../status/useDataVersionRefetch.js';
import { contextPct, timeAgo } from '../browse/format.js';
import {
  LIVE_STALL_KEY,
  LIVE_STALL_MINUTES,
  readLiveStall,
  readLiveWindow,
  writeLiveWindow,
  writeStored,
} from './prefs.js';
import './live.css';

/** Silent refetch cadence while the tab is visible (sessions age out without a data change). */
const REFRESH_MS = 30_000;
/** Re-render cadence for the relative "last write" ages. */
const TICK_MS = 5_000;
const MINUTE_MS = 60_000;

const WINDOW_OPTIONS = LIVE_WINDOW_MINUTES.map((m) => ({
  value: m,
  label: m === 60 ? '1 hour' : `${m} min`,
}));

/** States that should be writing while they run; silence in them is the stuck signal. */
const STALLABLE: LiveState[] = ['tool', 'working', 'subagents'];

function stateLabel(live: LiveSession): string {
  switch (live.state) {
    case 'idle':
      return 'Idle';
    case 'working':
      return 'Working';
    case 'tool':
      return live.openTool?.name ? `Running ${live.openTool.name}` : 'Running tool';
    case 'subagents':
      return 'Subagents running';
    case 'ended':
      return 'Ended';
    case 'unknown':
      return 'Unknown';
  }
}

function subagentLabel(subagents: LiveSession['subagents']): string {
  const parts: string[] = [];
  if (subagents.running > 0) parts.push(`${subagents.running} running`);
  if (subagents.done > 0) parts.push(`${subagents.done} done`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function contextLabel(live: LiveSession): string {
  const { contextTokens, contextWindow } = live.meta;
  if (contextTokens == null) return 'not recorded';
  if (contextWindow != null) {
    const pct = contextPct(contextTokens, contextWindow);
    if (pct) return pct;
  }
  return formatCount(contextTokens);
}

function costLabel(live: LiveSession): string {
  if (live.usageGranularity === 'none') return 'not recorded';
  if (live.usageGranularity === 'session-level' && live.state !== 'ended') return 'at session end';
  return formatCost(live.meta.totalCostUsd);
}

/**
 * Live view: sessions written to within a window, each with an inferred state.
 * "Possibly stuck" is derived here from the write timestamps, never from the
 * server, and says only that nothing was written — not why.
 */
export function LivePage() {
  const { indexer } = useServerStatus();
  const intervalS = indexer?.intervalMs ? Math.max(1, Math.round(indexer.intervalMs / 1000)) : null;
  const indexNote = `Updates with the index${intervalS ? ` · every ~${intervalS} s` : ''}`;
  const [windowMin, setWindowMin] = useState(readLiveWindow);
  const [stallMin, setStallMin] = useState(readLiveStall);
  const [data, setData] = useState<LiveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const inflight = useRef<AbortController | null>(null);
  const hasData = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  /** The only fetch path: a new call supersedes (aborts) whatever is in flight. */
  const refresh = useCallback(
    (silent: boolean) => {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      api
        .live(windowMin, controller.signal)
        .then((res) => {
          if (controller.signal.aborted) return;
          hasData.current = true;
          setData(res);
          setError(null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          // A silent failure keeps the rows on screen; it surfaces only when there is nothing to show.
          if (!silent || !hasData.current) setError(err);
          setLoading(false);
        });
    },
    [windowMin],
  );

  useEffect(() => {
    setLoading(true);
    setError(null);
    refresh(false);
    return () => inflight.current?.abort();
  }, [refresh, reloadKey]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh(true);
    };
    const timer = window.setInterval(onVisible, REFRESH_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  useDataVersionRefetch(() => refresh(true));

  const changeWindow = (value: number) => {
    writeLiveWindow(value);
    setWindowMin(value);
  };
  const changeStall = (value: number) => {
    writeStored(LIVE_STALL_KEY, value);
    setStallMin(value);
  };

  const sessions = data?.sessions ?? [];
  const truncated = data?.truncated ?? 0;
  const total = sessions.length + truncated;
  const stallMs = stallMin * MINUTE_MS;

  return (
    <section>
      <header className="tv-live__header">
        <div className="tv-live__titles">
          <h1 className="tv-page-title" style={{ marginBottom: 0 }}>
            Live
          </h1>
          <p className="tv-muted tv-live__sub">
            {data ? total : '…'} session{total === 1 ? '' : 's'} with activity in the last{' '}
            <select
              className="tv-select tv-live__inline-select"
              value={windowMin}
              onChange={(e) => changeWindow(Number(e.target.value))}
              aria-label="Activity window"
            >
              {WINDOW_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </p>
        </div>
        <div className="tv-live__controls">
          <label className="tv-live__field tv-muted">
            Possibly stuck after
            <select
              className="tv-select"
              value={stallMin}
              onChange={(e) => changeStall(Number(e.target.value))}
              aria-label="Possibly stuck after"
            >
              {LIVE_STALL_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {`${m} min`}
                </option>
              ))}
            </select>
          </label>
          <p className="tv-muted tv-live__note">{indexNote}</p>
        </div>
      </header>

      {loading ? (
        <Spinner size="lg" label="Loading live sessions…" />
      ) : error ? (
        <ErrorBox error={error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : sessions.length === 0 ? (
        <p className="tv-muted">No sessions written to in the last {windowMin} min.</p>
      ) : (
        <>
          <div className="tv-live__table-wrap">
            <table className="tv-live__table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>State</th>
                  <th>Subagents</th>
                  <th>Last write</th>
                  <th>Context</th>
                  <th>Cost so far</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((live) => (
                  <LiveRow key={live.meta.id} live={live} now={now} stallMs={stallMs} />
                ))}
              </tbody>
            </table>
          </div>
          {truncated > 0 ? (
            <p className="tv-muted tv-live__more">{truncated} more not shown.</p>
          ) : null}
        </>
      )}

      <p className="tv-muted tv-live__footer">
        States are inferred from the transcript; Claudescope never sees the agent process.
      </p>
    </section>
  );
}

function LiveRow({ live, now, stallMs }: { live: LiveSession; now: number; stallMs: number }) {
  const { meta } = live;
  const idleMs = now - live.lastWriteMs;
  const stuck = STALLABLE.includes(live.state) && idleMs > stallMs;
  const label = stateLabel(live);

  return (
    <tr>
      <td className="tv-live__session">
        <Link to={`/sessions/${encodeURIComponent(meta.id)}`} className="tv-live__title">
          {meta.title || 'Untitled session'}
        </Link>
        <div className="tv-live__meta tv-muted">
          <AgentBadge connectorId={meta.connectorId} />
          <span>{meta.projectDisplayName}</span>
          {meta.gitBranch ? <span className="tv-mono">· {meta.gitBranch}</span> : null}
        </div>
      </td>
      <td>
        {stuck ? (
          <>
            <span className="tv-live__pill tv-live__pill--stuck">
              <span className="tv-live__dot" aria-hidden="true" />
              Possibly stuck
            </span>
            <div className="tv-live__detail tv-muted">
              {`${label} · no writes for ${Math.floor(idleMs / MINUTE_MS)} min`}
            </div>
          </>
        ) : (
          <span className={`tv-live__pill tv-live__pill--${live.state}`}>
            <span className="tv-live__dot" aria-hidden="true" />
            {label}
          </span>
        )}
      </td>
      <td className="tv-live__nowrap">{subagentLabel(live.subagents)}</td>
      <td className="tv-live__nowrap">{timeAgo(new Date(live.lastWriteMs).toISOString())}</td>
      <td className="tv-live__nowrap">{contextLabel(live)}</td>
      <td className="tv-live__nowrap">{costLabel(live)}</td>
    </tr>
  );
}
