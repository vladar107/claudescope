import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  LIVE_WINDOW_MINUTES,
  type AgentUsageGranularity,
  type LiveFinished,
  type LiveOpenTool,
  type LiveResponse,
  type LiveRun,
  type LiveSession,
  type LiveState,
} from '@claudescope/shared';
import { api } from '../../api/client.js';
import {
  AgentBadge,
  ErrorBox,
  formatCost,
  Spinner,
  toolInputFileName,
} from '../../components';
import { useServerStatus } from '../../status/StatusProvider.js';
import { useDataVersionRefetch } from '../../status/useDataVersionRefetch.js';
import { contextPct } from '../browse/format.js';
import {
  LIVE_STALL_KEY,
  LIVE_STALL_MINUTES,
  readLiveStall,
  readLiveWindow,
  writeLiveWindow,
  writeStored,
} from './prefs.js';
import './live.css';

/** Refetch cadence while something is working and the tab is visible. */
const FAST_REFRESH_MS = 2_500;
/** Refetch cadence otherwise, and after a failed fetch (sessions still age out without a data change). */
const SLOW_REFRESH_MS = 30_000;
/** Re-render cadence for the relative ages. */
const TICK_MS = 1_000;
const MINUTE_MS = 60_000;
const MAX_RUN_LINES = 5;
const WARN_CONTEXT_RATIO = 0.8;

const WINDOW_OPTIONS = LIVE_WINDOW_MINUTES.map((m) => ({
  value: m,
  label: m === 60 ? '1 hour' : `${m} min`,
}));

/** States that should be writing while they run; silence in them is the stuck signal. */
const STALLABLE: LiveState[] = ['tool', 'working', 'subagents'];
const RUNNING: LiveState[] = ['working', 'tool', 'subagents'];

function stateLabel(state: LiveState, openTool?: LiveOpenTool): string {
  switch (state) {
    case 'idle':
      return 'Idle';
    case 'working':
      return 'Working';
    case 'tool':
      return openTool?.name ? `Running ${openTool.name}` : 'Running tool';
    case 'subagents':
      return 'Subagents running';
    case 'ended':
      return 'Ended';
    case 'unknown':
      return 'Unknown';
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** One-line summary of what a tool call is operating on: file name, else the first useful string field. */
function toolSummary(tool: LiveOpenTool): string {
  const file = toolInputFileName(tool.input);
  if (file) return `${tool.name} ${file}`;
  const input = asRecord(tool.input);
  for (const key of ['command', 'pattern', 'query', 'url', 'description', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return `${tool.name} ${value.trim().split('\n')[0]}`;
    }
  }
  return tool.name;
}

function ago(ms: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) return `${sec} s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} m ago`;
  const hr = Math.floor(min / 60);
  return hr < 24 ? `${hr} h ago` : `${Math.floor(hr / 24)} d ago`;
}

function elapsed(ms: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} m ${sec % 60} s`;
  return `${Math.floor(min / 60)} h ${min % 60} m`;
}

function costLabel(
  granularity: AgentUsageGranularity,
  ended: boolean,
  costUsd: number | undefined,
): string {
  if (granularity === 'none') return 'not recorded';
  if (granularity === 'session-level' && !ended) return 'at session end';
  return formatCost(costUsd ?? 0);
}

function isWorking(live: LiveSession): boolean {
  return RUNNING.includes(live.state);
}

/**
 * Live view: sessions written to within a window, each with an inferred state.
 * "Possibly stuck" is derived here from the write timestamps, never from the
 * server, and says only that nothing was written — not why.
 */
export function LivePage() {
  const { indexer } = useServerStatus();
  const intervalS = indexer?.intervalMs ? Math.max(1, Math.round(indexer.intervalMs / 1000)) : null;
  const indexNote = `Refreshes every few seconds while something is working, else ${
    intervalS ? `every ~${intervalS} s` : 'with the index'
  }`;
  const [windowMin, setWindowMin] = useState(readLiveWindow);
  const [stallMin, setStallMin] = useState(readLiveStall);
  const [data, setData] = useState<LiveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [failed, setFailed] = useState(false);
  const [settled, setSettled] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const inflight = useRef<AbortController | null>(null);
  const hasData = useRef(false);
  const etag = useRef<string | undefined>(undefined);

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
        .live(windowMin, controller.signal, silent ? etag.current : undefined)
        .then((res) => {
          if (controller.signal.aborted) return;
          etag.current = res.etag;
          if (res.data) {
            hasData.current = true;
            setData(res.data);
          }
          setError(null);
          setFailed(false);
          setLoading(false);
          setNow(Date.now());
          setSettled((n) => n + 1);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          // A silent failure keeps the cards on screen; it surfaces only when there is nothing to show.
          if (!silent || !hasData.current) setError(err);
          setFailed(true);
          setLoading(false);
          setSettled((n) => n + 1);
        });
    },
    [windowMin],
  );

  useEffect(() => {
    etag.current = undefined;
    hasData.current = false;
    setLoading(true);
    setError(null);
    refresh(false);
    return () => inflight.current?.abort();
  }, [refresh, reloadKey]);

  const working = useMemo(() => (data?.sessions ?? []).some(isWorking), [data]);

  // One timer chained off each settled fetch, so requests never overlap and a failure backs off.
  useEffect(() => {
    const delay = !failed && working ? FAST_REFRESH_MS : SLOW_REFRESH_MS;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === 'visible') refresh(true);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [settled, working, failed, refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
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
  const finished = data?.finished ?? [];
  const truncated = data?.truncated ?? 0;
  const total = sessions.length + truncated;
  const stallMs = stallMin * MINUTE_MS;
  const idleSessions = sessions.filter((s) => s.state === 'idle');
  const workingSessions = sessions.filter(isWorking);
  const otherSessions = sessions.filter((s) => s.state === 'ended' || s.state === 'unknown');

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
      ) : (
        <>
          {sessions.length === 0 ? (
            <p className="tv-muted">No sessions written to in the last {windowMin} min.</p>
          ) : null}
          <CardSection title="Idle" sessions={idleSessions} now={now} stallMs={stallMs} />
          <CardSection title="Working" sessions={workingSessions} now={now} stallMs={stallMs} />
          <CardSection title="Ended or unknown" sessions={otherSessions} now={now} stallMs={stallMs} />
          {truncated > 0 ? (
            <p className="tv-muted tv-live__more">{truncated} more not shown.</p>
          ) : null}
          {finished.length > 0 ? <FinishedTable finished={finished} now={now} /> : null}
        </>
      )}

      <p className="tv-muted tv-live__footer">
        States are inferred from the transcript; Claudescope never sees the agent process.
      </p>
    </section>
  );
}

function CardSection({
  title,
  sessions,
  now,
  stallMs,
}: {
  title: string;
  sessions: LiveSession[];
  now: number;
  stallMs: number;
}) {
  if (sessions.length === 0) return null;
  return (
    <div className="tv-live__section">
      <h2 className="tv-live__h2">
        {title} <span className="tv-muted tv-live__count">{sessions.length}</span>
      </h2>
      <div className="tv-live__grid">
        {sessions.map((live) => (
          <LiveCard key={live.meta.id} live={live} now={now} stallMs={stallMs} />
        ))}
      </div>
    </div>
  );
}

interface RunLine {
  run: LiveRun;
  depth: number;
}

/** Active runs, each nested run directly under its (active) parent. */
function runLines(runs: LiveRun[]): RunLine[] {
  const active = runs.filter((r) => r.active);
  const ids = new Set(active.map((r) => r.agentId));
  const out: RunLine[] = [];
  const walk = (parent: string | undefined, depth: number) => {
    for (const run of active) {
      const isRoot = parent === undefined && (!run.parentAgentId || !ids.has(run.parentAgentId));
      if (isRoot || (parent !== undefined && run.parentAgentId === parent)) {
        out.push({ run, depth });
        walk(run.agentId, depth + 1);
      }
    }
  };
  walk(undefined, 0);
  return out;
}

function runName(run: LiveRun): string {
  return run.description || run.agentType || 'subagent';
}

function LiveCard({ live, now, stallMs }: { live: LiveSession; now: number; stallMs: number }) {
  const { meta } = live;
  const idleMs = now - live.lastWriteMs;
  const stuck = STALLABLE.includes(live.state) && idleMs > stallMs;
  const label = stateLabel(live.state, live.openTool);
  const lines = runLines(live.runs);
  const doneRuns = live.runs.filter((r) => !r.active).length;
  const shown = lines.slice(0, MAX_RUN_LINES);
  const { contextTokens, contextWindow } = meta;
  const ratio =
    contextTokens != null && contextWindow ? Math.min(1, contextTokens / contextWindow) : undefined;
  const pct = contextPct(contextTokens, contextWindow);

  let since = '';
  if (live.state === 'tool' && live.openTool?.sinceMs != null) {
    since = `for ${elapsed(live.openTool.sinceMs, now)}`;
  } else if ((live.state === 'idle' || live.state === 'working') && live.stateSinceMs != null) {
    since = `since ${elapsed(live.stateSinceMs, now)} ago`;
  }

  return (
    <article className={`tv-live__card${live.state === 'idle' ? ' tv-live__card--idle' : ''}`}>
      <div className="tv-live__card-top">
        <AgentBadge connectorId={meta.connectorId} />
        <span className="tv-mono tv-muted tv-live__project">
          {meta.projectDisplayName}
          {meta.gitBranch ? ` · ${meta.gitBranch}` : ''}
        </span>
        <span className="tv-muted tv-live__nowrap tv-live__last-write">
          last write {ago(live.lastWriteMs, now)}
        </span>
      </div>

      <Link to={`/sessions/${encodeURIComponent(meta.id)}`} className="tv-live__title">
        {meta.title || 'Untitled session'}
      </Link>

      <div className="tv-live__state-row">
        {stuck ? (
          <span className="tv-live__pill tv-live__pill--stuck">
            <span className="tv-live__dot" aria-hidden="true" />
            Possibly stuck
          </span>
        ) : (
          <span className={`tv-live__pill tv-live__pill--${live.state}`}>
            <span className="tv-live__dot" aria-hidden="true" />
            {label}
          </span>
        )}
        <span className="tv-muted tv-live__since">
          {stuck ? `${label} · no writes for ${Math.floor(idleMs / MINUTE_MS)} min` : since}
        </span>
      </div>

      {live.state === 'tool' && live.openTool ? (
        <div className="tv-mono tv-live__tool">{toolSummary(live.openTool)}</div>
      ) : null}
      {live.state === 'idle' && live.lastText ? (
        <p className="tv-muted tv-live__quote">{live.lastText}</p>
      ) : null}

      {shown.length > 0 || doneRuns > 0 ? (
        <div className="tv-live__runs">
          {shown.length > 0 ? (
            <ul className="tv-live__run-list">
              {shown.map(({ run, depth }) => (
                <li
                  key={run.agentId}
                  className="tv-live__run"
                  style={{ paddingLeft: `${depth * 16}px` }}
                >
                  <span className="tv-muted" aria-hidden="true">
                    {depth > 0 ? '└' : '├'}
                  </span>
                  <span className="tv-live__run-name">{runName(run)}</span>
                  <span className="tv-mono tv-muted tv-live__run-what">
                    {run.openTool ? toolSummary(run.openTool) : stateLabel(run.state, run.openTool)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {lines.length > shown.length ? (
            <p className="tv-muted tv-live__run-more">+ {lines.length - shown.length} more</p>
          ) : null}
          {doneRuns > 0 ? <p className="tv-muted tv-live__run-more">+ {doneRuns} done</p> : null}
        </div>
      ) : null}

      <footer className="tv-live__card-foot tv-muted">
        {ratio !== undefined ? (
          <span className="tv-live__ctx">
            <span className="tv-live__bar" aria-hidden="true">
              <span
                className={`tv-live__bar-fill${ratio >= WARN_CONTEXT_RATIO ? ' tv-live__bar-fill--warn' : ''}`}
                style={{ width: `${Math.round(ratio * 100)}%` }}
              />
            </span>
            {pct} context
          </span>
        ) : contextTokens == null ? (
          <span>context not recorded</span>
        ) : null}
        {meta.compactionCount !== undefined ? (
          <span>
            {meta.compactionCount} compaction{meta.compactionCount === 1 ? '' : 's'}
          </span>
        ) : null}
        <span>
          {meta.toolCallCount} tool{meta.toolCallCount === 1 ? '' : 's'}
          {live.toolErrors ? ` · ${live.toolErrors} failed` : ''}
        </span>
        <span className="tv-live__cost">
          {costLabel(live.usageGranularity, live.state === 'ended', meta.totalCostUsd)}
        </span>
      </footer>
    </article>
  );
}

function FinishedTable({ finished, now }: { finished: LiveFinished[]; now: number }) {
  return (
    <div className="tv-live__section">
      <h2 className="tv-live__h2">
        Finished in the last hour <span className="tv-muted tv-live__count">{finished.length}</span>
      </h2>
      <div className="tv-live__table-wrap">
        <table className="tv-live__table">
          <thead>
            <tr>
              <th>Session</th>
              <th>Agent</th>
              <th>Project</th>
              <th>Last write</th>
              <th>Cost so far</th>
            </tr>
          </thead>
          <tbody>
            {finished.map(({ meta, lastWriteMs, usageGranularity }) => (
              <tr key={meta.id}>
                <td>
                  <Link to={`/sessions/${encodeURIComponent(meta.id)}`} className="tv-live__title">
                    {meta.title || 'Untitled session'}
                  </Link>
                </td>
                <td>
                  <AgentBadge connectorId={meta.connectorId} />
                </td>
                <td className="tv-mono">{meta.projectDisplayName}</td>
                <td className="tv-live__nowrap">{ago(lastWriteMs, now)}</td>
                <td className="tv-live__nowrap">
                  {costLabel(usageGranularity, true, meta.totalCostUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
