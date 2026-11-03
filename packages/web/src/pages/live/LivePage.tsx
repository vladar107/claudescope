import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  LIVE_WINDOW_MINUTES,
  type AgentUsageGranularity,
  type LiveFinished,
  type LiveResponse,
  type LiveRun,
  type AnalyticsTotals,
  type LiveSession,
} from '@claudescope/shared';
import { api } from '../../api/client.js';
import { AgentBadge, ErrorBox, formatCost, formatCount, Spinner } from '../../components';
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
import {
  ago,
  elapsed,
  RUNNING,
  runName,
  STALLABLE,
  stateLabel,
  toolSummary,
} from './liveFormat.js';
import {
  burnRate,
  formatRate,
  readNotify,
  recentActivity,
  SPARK_MINUTES,
  sparkPoints,
  writeNotify,
} from './liveTrends.js';
import { TIME_ZONE, todayInTimeZone } from '../analytics/format.js';
import './live.css';

/** Refetch cadence while something is working and the tab is visible. */
const FAST_REFRESH_MS = 2_500;
/** Refetch cadence otherwise, and after a failed fetch (sessions still age out without a data change). */
const SLOW_REFRESH_MS = 30_000;
/** Refetch cadence while the tab is hidden and idle notifications are on. */
const HIDDEN_NOTIFY_REFRESH_MS = 15_000;
/** Re-render cadence for the relative ages. */
const TICK_MS = 1_000;
const MINUTE_MS = 60_000;
const MAX_RUN_LINES = 5;
const WARN_CONTEXT_RATIO = 0.8;

const WINDOW_OPTIONS = LIVE_WINDOW_MINUTES.map((m) => ({
  value: m,
  label: m === 60 ? '1 hour' : `${m} min`,
}));

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
  const { indexer, dataVersion } = useServerStatus();
  const navigate = useNavigate();
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
  const [notify, setNotify] = useState(readNotify);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const [notifyBlocked, setNotifyBlocked] = useState(false);
  const [today, setToday] = useState<{ totals?: AnalyticsTotals; failed?: boolean }>({});

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
  // A hidden tab stops polling unless notifications are on: idle transitions are only seen by polling.
  useEffect(() => {
    const hidden = document.visibilityState !== 'visible';
    const delay = hidden ? HIDDEN_NOTIFY_REFRESH_MS : !failed && working ? FAST_REFRESH_MS : SLOW_REFRESH_MS;
    const timer = window.setTimeout(() => {
      if (document.visibilityState === 'visible' || notifyRef.current) refresh(true);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [settled, working, failed, refresh, notify]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  useDataVersionRefetch(() => refresh(true));

  // Today's totals follow the index (dataVersion) and the local date, never the 2.5 s poll.
  const nowMinute = Math.floor(now / MINUTE_MS);
  const todayDate = useMemo(() => todayInTimeZone(), [nowMinute]);
  useEffect(() => {
    if (dataVersion === null) return;
    const date = todayDate;
    const controller = new AbortController();
    api
      .analytics({ groupBy: 'day', from: date, to: date, timeZone: TIME_ZONE }, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setToday({ totals: res.totals });
      })
      .catch(() => {
        if (!controller.signal.aborted) setToday((prev) => (prev.totals ? prev : { failed: true }));
      });
    return () => controller.abort();
  }, [dataVersion, todayDate]);

  // Permission can be revoked in the browser after opting in: drop the opt-in rather than keep
  // polling a hidden tab for notifications that can no longer fire.
  useEffect(() => {
    const check = () => {
      if (!notifyRef.current) return;
      if ('Notification' in window && Notification.permission === 'granted') return;
      writeNotify(false);
      setNotify(false);
      setNotifyBlocked(true);
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, []);

  // Transitions are observed between successive responses; the first one is only recorded.
  const prevStates = useRef<Map<string, LiveSession['state']> | null>(null);
  const hiddenIdle = useRef(0);
  const baseTitle = useRef<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const prev = prevStates.current;
    prevStates.current = new Map(data.sessions.map((s) => [s.meta.id, s.state]));
    if (!prev) return;
    for (const s of data.sessions) {
      const before = prev.get(s.meta.id);
      if (s.state !== 'idle' || before === undefined || !RUNNING.includes(before)) continue;
      if (notifyRef.current && document.visibilityState === 'hidden') {
        baseTitle.current ??= document.title;
        hiddenIdle.current += 1;
        document.title = `(${hiddenIdle.current}) ${baseTitle.current}`;
      }
      if (notifyRef.current && 'Notification' in window && Notification.permission === 'granted') {
        const note = new Notification(s.meta.title || 'Untitled session', {
          body: `Idle — ${s.meta.projectDisplayName}`,
          tag: s.meta.id,
        });
        note.onclick = () => {
          window.focus();
          navigate(`/sessions/${encodeURIComponent(s.meta.id)}`);
          note.close();
        };
      }
    }
  }, [data, navigate]);

  useEffect(() => {
    const restore = () => {
      if (document.visibilityState === 'visible' && baseTitle.current !== null) {
        document.title = baseTitle.current;
        baseTitle.current = null;
        hiddenIdle.current = 0;
      }
    };
    document.addEventListener('visibilitychange', restore);
    return () => {
      document.removeEventListener('visibilitychange', restore);
      restore();
      if (baseTitle.current !== null) document.title = baseTitle.current;
    };
  }, []);

  const lanesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'j' && e.key !== 'k') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.closest('input, select, textarea') || target.isContentEditable)) return;
      const links = Array.from(
        lanesRef.current?.querySelectorAll<HTMLAnchorElement>('.tv-live__title') ?? [],
      );
      if (links.length === 0) return;
      const at = links.indexOf(document.activeElement as HTMLAnchorElement);
      const next =
        e.key === 'j'
          ? at < 0
            ? 0
            : Math.min(links.length - 1, at + 1)
          : at < 0
            ? links.length - 1
            : Math.max(0, at - 1);
      links[next]?.focus();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const changeNotify = (on: boolean) => {
    setNotifyBlocked(false);
    if (!on) {
      writeNotify(false);
      setNotify(false);
      return;
    }
    if (!('Notification' in window)) {
      setNotifyBlocked(true);
      return;
    }
    const apply = (permission: NotificationPermission) => {
      const granted = permission === 'granted';
      writeNotify(granted);
      setNotify(granted);
      setNotifyBlocked(!granted);
    };
    if (Notification.permission === 'default') {
      void Notification.requestPermission().then(apply);
    } else {
      apply(Notification.permission);
    }
  };

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
  const isStuck = (s: LiveSession) => STALLABLE.includes(s.state) && now - s.lastWriteMs > stallMs;
  const idleSessions = sessions
    .filter((s) => s.state === 'idle')
    .sort((a, b) => a.lastWriteMs - b.lastWriteMs);
  const otherSessions = sessions.filter((s) => s.state === 'ended' || s.state === 'unknown');
  const workingSessions = sessions
    .filter((s) => isWorking(s) && !isStuck(s))
    .sort((a, b) => recentActivity(b, now) - recentActivity(a, now));
  const stuckSessions = sessions
    .filter((s) => isWorking(s) && isStuck(s))
    .sort((a, b) => a.lastWriteMs - b.lastWriteMs);
  const rates = sessions.map((s) => burnRate(s, now)).filter((r): r is number => r !== undefined);
  const burn = rates.length > 0 ? formatRate(rates.reduce((a, b) => a + b, 0)) : '—';

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
          <label className="tv-live__field tv-muted">
            <input
              type="checkbox"
              checked={notify}
              onChange={(e) => changeNotify(e.target.checked)}
            />
            Notify me when a session goes idle
          </label>
          {notifyBlocked ? (
            <p className="tv-muted tv-live__note">Notifications are blocked by the browser</p>
          ) : null}
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
          <dl className="tv-live__kpis">
            <Kpi label={`In last ${windowMin} min`} value={String(total)} />
            <Kpi label="Idle now" value={String(idleSessions.length)} />
            <Kpi
              label="Burn rate now"
              value={burn}
              title={rates.length === 0 ? 'No live cost data' : undefined}
            />
            <span className="tv-live__kpi-sep" aria-hidden="true" />
            <Kpi
              label="Spend today"
              value={today.totals ? formatCost(today.totals.costUsd) : today.failed ? '—' : '…'}
            />
            <Kpi
              label="Tokens today"
              value={
                today.totals ? formatCount(today.totals.totalTokens) : today.failed ? '—' : '…'
              }
            />
          </dl>
          <div className="tv-live__lanes" ref={lanesRef}>
            <Lane
              title="Idle"
              hint="oldest idle first"
              tone="idle"
              sessions={idleSessions}
              now={now}
              stallMs={stallMs}
            />
            <Lane
              title="Working"
              hint="busiest first"
              tone="working"
              sessions={workingSessions}
              now={now}
              stallMs={stallMs}
            />
            <Lane
              title="Possibly stuck"
              hint="longest silent first"
              tone="stuck"
              sessions={stuckSessions}
              now={now}
              stallMs={stallMs}
            />
            {otherSessions.length > 0 ? (
              <Lane
                title="Ended or unknown"
                hint="newest first"
                tone="idle"
                sessions={otherSessions}
                now={now}
                stallMs={stallMs}
              />
            ) : null}
          </div>
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

function Kpi({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="tv-live__kpi" title={title}>
      <dt className="tv-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Lane({
  title,
  hint,
  tone,
  sessions,
  now,
  stallMs,
}: {
  title: string;
  hint: string;
  tone: 'idle' | 'working' | 'stuck';
  sessions: LiveSession[];
  now: number;
  stallMs: number;
}) {
  return (
    <section className={`tv-live__lane tv-live__lane--${tone}`}>
      <h2 className="tv-live__h2 tv-live__lane-head">
        <span className="tv-live__dot" aria-hidden="true" />
        {title} <span className="tv-muted tv-live__count">{sessions.length}</span>
        <span className="tv-muted tv-live__hint">{hint}</span>
      </h2>
      {sessions.length === 0 ? (
        <p className="tv-muted tv-live__none">None</p>
      ) : (
        <div className="tv-live__lane-cards">
          {sessions.map((live) => (
            <LiveCard key={live.meta.id} live={live} now={now} stallMs={stallMs} />
          ))}
        </div>
      )}
    </section>
  );
}

function Sparkline({ live, now }: { live: LiveSession; now: number }) {
  const points = sparkPoints(live, now);
  const total = points.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...points);
  const step = 120 / (SPARK_MINUTES - 1);
  const d = points.map((v, i) => `${(i * step).toFixed(1)},${(22 - (v / max) * 20).toFixed(1)}`);
  return (
    <svg
      className="tv-live__spark"
      width="120"
      height="24"
      viewBox="0 0 120 24"
      role="img"
      aria-label={`Activity: ${total} events in the last ${SPARK_MINUTES} minutes`}
    >
      <polyline points={d.join(' ')} fill="none" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
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

  const rate = burnRate(live, now);
  let rateText = '';
  if (live.state !== 'idle' && rate !== undefined) rateText = formatRate(rate);
  else if (live.state !== 'idle' && live.usageGranularity === 'session-level') rateText = 'cost lands at session end';

  const ticks = (live.compactions ?? [])
    .map((c) => c.preTokens)
    .filter((t): t is number => t != null && !!contextWindow && t > 0);

  let since = '';
  if (live.state === 'tool' && live.openTool?.sinceMs != null) {
    since = `for ${elapsed(live.openTool.sinceMs, now)}`;
  } else if ((live.state === 'idle' || live.state === 'working') && live.stateSinceMs != null) {
    since = `since ${elapsed(live.stateSinceMs, now)} ago`;
  }

  return (
    <article
      className={`tv-live__card tv-live__card--${stuck ? 'stuck' : live.state}${live.state === 'idle' ? ' tv-live__card--idle' : ''}`}
    >
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

      <div className="tv-live__trend">
        <Sparkline live={live} now={now} />
        {rateText ? <span className="tv-muted tv-live__rate">{rateText}</span> : null}
      </div>

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
              {ticks.map((t, i) => (
                <span
                  key={i}
                  className="tv-live__tick"
                  style={{ left: `${Math.min(100, (t / (contextWindow ?? 1)) * 100)}%` }}
                />
              ))}
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
      {live.runs.length > 0 ? (
        <Link to={`/live/${encodeURIComponent(meta.id)}`} className="tv-live__focus-link">
          Agents &amp; messages
        </Link>
      ) : null}
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
