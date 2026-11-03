import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router';
import type {
  AgentMessage,
  AgentMessageKind,
  LiveRun,
  LiveSession,
  LiveSessionDetail,
  LiveState,
} from '@claudescope/shared';
import { api } from '../../api/client.js';
import { AgentBadge, ErrorBox, Spinner } from '../../components';
import { readLiveStall, readLiveWindow } from './prefs.js';
import {
  ago,
  RUNNING,
  runName,
  STALLABLE,
  stateLabel,
  toolSummary,
} from './liveFormat.js';
import './live.css';
import './live-focus.css';

const FAST_REFRESH_MS = 2_500;
const SLOW_REFRESH_MS = 30_000;
const TICK_MS = 1_000;
const MINUTE_MS = 60_000;
const MAIN = 'main';

const KIND_WORD: Record<AgentMessageKind, string> = {
  spawn: 'Spawn',
  message: 'Message',
  result: 'Result',
  notification: 'Notification',
  wait: 'Wait',
  stop: 'Stop',
};
const KINDS = Object.keys(KIND_WORD) as AgentMessageKind[];

const SIGNAL_NOTE = {
  'spawn-result':
    "This agent's format records spawns and results only; messages sent mid-run are not recorded.",
  none: "This agent's format records no linkage between agents.",
} as const;

interface Lane {
  id: string;
  name: string;
  depth: number;
  run?: LiveRun;
}

/** `main` first, then each run under its parent (else main) in the server's order. */
function buildLanes(live: LiveSession): Lane[] {
  const ids = new Set(live.runs.map((r) => r.agentId));
  const lanes: Lane[] = [{ id: MAIN, name: MAIN, depth: 0 }];
  const seen = new Set<string>();
  const walk = (parent: string, depth: number) => {
    for (const run of live.runs) {
      const p = run.parentAgentId && ids.has(run.parentAgentId) ? run.parentAgentId : MAIN;
      if (p !== parent || seen.has(run.agentId)) continue;
      seen.add(run.agentId);
      lanes.push({ id: run.agentId, name: runName(run), depth, run });
      walk(run.agentId, depth + 1);
    }
  };
  walk(MAIN, 1);
  return lanes;
}

function clock(at?: number): string {
  if (at == null) return '--:--:--';
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

/** Messages can share an anchor (merged Codex calls, Workflow spawns), so the key counts repeats. */
function messageKeys(messages: AgentMessage[]): string[] {
  const seen = new Map<string, number>();
  return messages.map((m) => {
    const base = [m.kind, m.anchorUuid ?? '', m.from, m.to ?? '', m.at ?? ''].join(':');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}:${n}`;
  });
}

/** Run items live inside collapsed panels that are not mounted, so a run's items deep-link to its spawn block. */
function transcriptHref(sessionId: string, m: AgentMessage): string | undefined {
  const base = `/sessions/${encodeURIComponent(sessionId)}`;
  if (m.anchorAgentId) return `${base}#subagent-${encodeURIComponent(m.anchorAgentId)}`;
  return m.anchorUuid ? `${base}#${encodeURIComponent(m.anchorUuid)}` : undefined;
}

/** Focus view of one live session: its agent tree and the messages between agents. */
export function LiveFocusPage() {
  const { sessionId = '' } = useParams<{ sessionId: string }>();
  const [data, setData] = useState<LiveSessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [failed, setFailed] = useState(false);
  const [settled, setSettled] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [stallMs] = useState(() => readLiveStall() * MINUTE_MS);

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
        .liveSession(sessionId, readLiveWindow(), controller.signal, silent ? etag.current : undefined)
        .then((res) => {
          if (controller.signal.aborted) return;
          etag.current = res.etag;
          hasData.current = true;
          if (res.data) setData(res.data);
          setError(null);
          setFailed(false);
          setLoading(false);
          setNow(Date.now());
          setSettled((n) => n + 1);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          if (!silent || !hasData.current) setError(err);
          setFailed(true);
          setLoading(false);
          setSettled((n) => n + 1);
        });
    },
    [sessionId],
  );

  useEffect(() => {
    hasData.current = false;
    etag.current = undefined;
    setData(null);
    setSelected(null);
    setLoading(true);
    setError(null);
    refresh(false);
    return () => inflight.current?.abort();
  }, [refresh, reloadKey]);

  const working = data ? RUNNING.includes(data.session.state) : false;

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

  const lanes = useMemo(() => (data ? buildLanes(data.session) : []), [data]);

  if (loading) return <Spinner size="lg" label="Loading session…" />;
  if (error || !data) {
    return <ErrorBox error={error} onRetry={() => setReloadKey((k) => k + 1)} />;
  }

  const { session: live, messages, messageSignal } = data;
  const { meta } = live;
  const idleMs = now - live.lastWriteMs;
  const stuck = STALLABLE.includes(live.state) && idleMs > stallMs;
  const label = stateLabel(live.state, live.openTool);
  const keys = messageKeys(messages);
  const pickedIndex = selected === null ? -1 : keys.indexOf(selected);
  const picked = messages[pickedIndex >= 0 ? pickedIndex : messages.length - 1];
  const laneIndex = (id?: string) => Math.max(0, lanes.findIndex((l) => l.id === id));
  const laneName = (id?: string) => (id ? (lanes.find((l) => l.id === id)?.name ?? id) : '?');
  const sessionHref = `/sessions/${encodeURIComponent(meta.id)}`;

  return (
    <section>
      <p className="tv-muted tv-focus__crumb">
        <Link to="/live">Live</Link> / {meta.projectDisplayName}
        {meta.gitBranch ? ` · ${meta.gitBranch}` : ''}
      </p>
      <header className="tv-focus__head">
        <h1 className="tv-page-title tv-focus__title">{meta.title || 'Untitled session'}</h1>
        <AgentBadge connectorId={meta.connectorId} />
        <span className={`tv-live__pill tv-live__pill--${stuck ? 'stuck' : live.state}`}>
          <span className="tv-live__dot" aria-hidden="true" />
          {stuck ? 'Possibly stuck' : label}
        </span>
        <Link to={sessionHref} className="tv-focus__open">
          Open full transcript
        </Link>
      </header>

      <div className="tv-focus__cols">
        <div className="tv-focus__left">
          <h2 className="tv-focus__h2">Agents</h2>
          <ul className="tv-focus__tree">
            {lanes.map((lane) => (
              <AgentNode key={lane.id} lane={lane} live={live} stuck={stuck} now={now} />
            ))}
          </ul>
          {live.runs.length === 0 ? <p className="tv-muted">No subagents in this session.</p> : null}
        </div>

        <div className="tv-focus__right">
          <h2 className="tv-focus__h2">Messages between agents</h2>
          <ul className="tv-focus__legend" aria-label="Legend">
            {KINDS.map((kind) => (
              <li key={kind} className={`tv-focus__kind--${kind}`}>
                <span
                  className={`tv-focus__sample${kind === 'wait' ? ' tv-focus__sample--wait' : ''}`}
                  aria-hidden="true"
                />
                <span className="tv-muted">{KIND_WORD[kind]}</span>
              </li>
            ))}
          </ul>

          {messages.length === 0 ? (
            <p className="tv-muted">No messages between agents yet.</p>
          ) : (
            <div className="tv-focus__scroll">
              <div className="tv-focus__lanes" style={{ '--lanes': lanes.length } as CSSProperties}>
                <div className="tv-focus__lane-head" aria-hidden="true" />
                {lanes.map((lane) => (
                  <div key={lane.id} className="tv-focus__lane-head" title={lane.name}>
                    {lane.name}
                  </div>
                ))}
                {messages.map((m, i) => {
                  const key = keys[i]!;
                  const from = laneIndex(m.from);
                  const hasTo = m.to !== undefined;
                  const to = hasTo ? laneIndex(m.to) : from;
                  const lo = Math.min(from, to);
                  const span = Math.abs(from - to) + 1;
                  const dir = to > from ? 'right' : 'left';
                  const arrowClass = !hasTo
                    ? 'stub'
                    : from === to
                      ? 'self'
                      : dir;
                  const time = clock(m.at);
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`tv-focus__row${m === picked ? ' is-selected' : ''}`}
                      aria-pressed={m === picked}
                      aria-label={`${KIND_WORD[m.kind]} from ${laneName(m.from)} to ${laneName(m.to)} at ${time}`}
                      onClick={() => setSelected(key)}
                    >
                      <span className="tv-focus__time tv-muted">{time}</span>
                      {lanes.map((lane, li) => (
                        <span
                          key={lane.id}
                          className="tv-focus__life"
                          style={{ gridColumn: li + 2 }}
                          aria-hidden="true"
                        />
                      ))}
                      <span
                        className={`tv-focus__label tv-focus__kind--${m.kind}`}
                        style={{ gridColumn: `${lo + 2} / -1` }}
                        aria-hidden="true"
                      >
                        <span className="tv-focus__kind-word">{KIND_WORD[m.kind]}</span>
                        <span className="tv-muted">{(m.text ?? '').split('\n')[0]}</span>
                      </span>
                      <span
                        className={`tv-focus__arrow tv-focus__arrow--${arrowClass} tv-focus__kind--${m.kind}${m.kind === 'wait' ? ' tv-focus__arrow--wait' : ''}`}
                        style={
                          {
                            gridColumn: hasTo && from !== to ? `${lo + 2} / span ${span}` : from + 2,
                            '--span': hasTo && from !== to ? span : 1,
                          } as CSSProperties
                        }
                        aria-hidden="true"
                      >
                        {hasTo ? null : <span className="tv-focus__arrow-q">?</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {picked ? (
            <div className="tv-focus__detail">
              <div className="tv-focus__detail-meta">
                <strong className={`tv-focus__kind--${picked.kind}`}>{KIND_WORD[picked.kind]}</strong>
                <span>
                  {laneName(picked.from)} <span aria-hidden="true">→</span>
                  <span className="tv-visually-hidden"> to</span> {laneName(picked.to)}
                </span>
                <span className="tv-muted">{clock(picked.at)}</span>
                {picked.status ? <span className="tv-muted">{picked.status}</span> : null}
              </div>
              {picked.text ? <pre className="tv-focus__detail-text">{picked.text}</pre> : null}
              {transcriptHref(meta.id, picked) ? (
                <Link to={transcriptHref(meta.id, picked)!}>Jump to it in the transcript</Link>
              ) : null}
            </div>
          ) : null}
          {messageSignal !== 'mid-run' ? (
            <p className="tv-muted tv-focus__note">{SIGNAL_NOTE[messageSignal]}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function AgentNode({
  lane,
  live,
  stuck,
  now,
}: {
  lane: Lane;
  live: LiveSession;
  stuck: boolean;
  now: number;
}) {
  const run = lane.run;
  let state: LiveState;
  let stateText: string;
  let dot: string;
  let tool = run ? run.openTool : live.openTool;
  let lastMs: number | undefined;
  if (run) {
    state = run.state;
    stateText = run.active ? stateLabel(run.state, run.openTool) : 'Done';
    dot = run.active ? run.state : 'done';
    lastMs = run.lastItemMs;
    if (!run.active) tool = undefined;
  } else {
    state = live.state;
    stateText = stuck ? 'Possibly stuck' : stateLabel(live.state, live.openTool);
    dot = stuck ? 'stuck' : live.state;
    lastMs = live.lastWriteMs;
  }
  return (
    <li className="tv-focus__node" style={{ marginLeft: `${lane.depth * 20}px` }}>
      <span className={`tv-focus__node-dot tv-focus__dot--${dot}`} aria-hidden="true" />
      <span className="tv-focus__node-name">
        <strong>{run ? runName(run) : MAIN}</strong>
        {run && run.description && run.agentType ? (
          <span className="tv-muted"> {run.agentType}</span>
        ) : null}
      </span>
      <span className="tv-focus__node-state tv-muted" data-state={state}>
        {stateText}
      </span>
      {tool ? (
        <span className="tv-mono tv-focus__node-sub">{toolSummary(tool)}</span>
      ) : null}
      {lastMs != null ? (
        <span className="tv-muted tv-focus__node-sub tv-focus__node-age">{ago(lastMs, now)}</span>
      ) : null}
    </li>
  );
}
