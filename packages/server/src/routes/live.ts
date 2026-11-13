/**
 * GET /api/live — sessions written to within the live window, each with a state
 * inferred from its transcript tail (`detail=full` raises the text caps for the
 * CLI and other non-browser pollers). GET /api/live/count — the same selection,
 * stat-only, for the nav badge: it never loads or parses a transcript.
 *
 * Selection is two-step. The `files` table narrows candidates cheaply (its
 * mtimes lag the disk by up to one reindex interval, hence the slack), then a
 * live stat through the owning connector confirms them. A newly active session
 * is therefore picked up within one reindex interval (longer while the indexer
 * is paused); once a candidate, its live stats track the transcript with no
 * further reindex.
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  AgentMessage,
  LiveMinuteCost,
  LiveCountResponse,
  LiveFinished,
  LiveResponse,
  LiveSession,
  LiveSessionDetail,
  SessionMeta,
} from '@claudescope/shared';
import { LIVE_DEFAULT_WINDOW_MINUTES, LIVE_WINDOW_MINUTES } from '@claudescope/shared';
import { connectorById } from '../connectors/registry.js';
import { agentMessageSignal, hasPromptSizedUsage, usageGranularity } from '../data/agent-capabilities.js';
import { buildAgentMessages } from '../data/agent-messages.js';
import { fingerprintFromRows } from '../data/fingerprint.js';
import { getDataVersion } from '../data/index.js';
import {
  ACTIVITY_WINDOW_MS,
  deriveLiveState,
  trimMinutes,
  type LiveStateResult,
} from '../data/live-state.js';
import { assembleThread, buildSubagentRuns } from '../data/parser.js';
import { COST_KEEP_MS, getLiveSnapshot, type LiveSnapshot, type SnapshotFile } from '../data/live-snapshot.js';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { reindexIntervalMs } from '../settings.js';
import { rowToSessionMeta } from './sessions.js';

const LIVE_CAP = 20;
const FINISHED_CAP = 10;
const FINISHED_MAX_AGE_MS = 60 * 60_000;
// An actively written transcript changes its fingerprint on every poll from
// every open tab; within this floor the cached result is served regardless.
const REDERIVE_FLOOR_MS = 1000;
// Only subagent-run liveness reads the clock and window, so a result for a
// session with runs ages out well inside the client's 30 s poll; one without
// runs is valid for as long as its fingerprint matches.
const RUNS_CACHE_MAX_AGE_MS = 10_000;
const DETAIL_MESSAGES_MAX = 500;

interface LiveCandidate {
  id: string;
  fingerprint: string;
  lastModifiedMs: number;
  files: SnapshotFile[];
}

interface CacheEntry {
  fingerprint: string;
  windowMs: number;
  hasRuns: boolean;
  result: LiveStateResult;
  derivedAtMs: number;
}

// Derived results only — never threads or transcript text. One map per
// `detail` variant: their text caps differ, so an entry must never serve the other.
const caches = { default: new Map<string, CacheEntry>(), full: new Map<string, CacheEntry>() };

function windowMsFrom(raw: string | undefined): { windowMinutes: number; windowMs: number } {
  const n = Number(raw);
  const windowMinutes = (LIVE_WINDOW_MINUTES as readonly number[]).includes(n)
    ? n
    : LIVE_DEFAULT_WINDOW_MINUTES;
  return { windowMinutes, windowMs: windowMinutes * 60_000 };
}

/** Live sessions, newest write first, selected from the index snapshot plus a live stat. */
function findLiveSessions(snap: LiveSnapshot, nowMs: number, windowMs: number): LiveCandidate[] {
  const floor = Math.floor(nowMs - windowMs - reindexIntervalMs());
  const live: LiveCandidate[] = [];
  for (const [id, files] of snap.files) {
    if (Math.max(...files.map((f) => f.mtime_ms)) < floor) continue;
    const { fingerprint, lastModifiedMs } = fingerprintFromRows(files);
    if (lastModifiedMs >= nowMs - windowMs) {
      live.push({ id, fingerprint, lastModifiedMs, files });
    }
  }
  live.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs || (a.id < b.id ? -1 : 1));
  return live;
}

/** Sessions last written within the hour but already past the live window, newest first. */
function findFinishedSessions(
  snap: LiveSnapshot,
  nowMs: number,
  windowMs: number,
  liveIds: ReadonlySet<string>,
): LiveFinished[] {
  if (windowMs >= FINISHED_MAX_AGE_MS) return [];
  const floor = Math.floor(nowMs - FINISHED_MAX_AGE_MS - reindexIntervalMs());
  const finished: LiveFinished[] = [];
  for (const [id, files] of snap.files) {
    if (liveIds.has(id) || Math.max(...files.map((f) => f.mtime_ms)) < floor) continue;
    const { lastModifiedMs } = fingerprintFromRows(files);
    if (lastModifiedMs >= nowMs - windowMs || lastModifiedMs < nowMs - FINISHED_MAX_AGE_MS) continue;
    const row = snap.sessionRows.get(id);
    if (!row) continue;
    const meta = rowToSessionMeta(row);
    finished.push({ meta, lastWriteMs: lastModifiedMs, usageGranularity: usageGranularity(meta.connectorId) });
  }
  finished.sort((a, b) => b.lastWriteMs - a.lastWriteMs || (a.meta.id < b.meta.id ? -1 : 1));
  return finished.slice(0, FINISHED_CAP);
}

async function loadThread(meta: SessionMeta, candidate: LiveCandidate) {
  const paths = candidate.files.map((f) => f.path);
  const { mainEvents, subagents, endedAt } = await connectorById(
    String(candidate.files[0]?.connector_id ?? ''),
  ).loadSession(candidate.id, paths, { resolveImages: false });
  const assemble = { deriveContextSizes: hasPromptSizedUsage(meta.connectorId) };
  const thread = assembleThread(mainEvents, assemble);
  const runs = buildSubagentRuns(thread, subagents, assemble);
  return { thread, runs, endedAt };
}

const UNKNOWN_STATE: LiveStateResult = { state: 'unknown', subagents: { running: 0, done: 0 }, runs: [], activity: [] };

export function toLiveSession(
  meta: SessionMeta,
  lastWriteMs: number,
  derived: LiveStateResult,
  nowMs: number,
  costMinutes: LiveMinuteCost[] | undefined,
): LiveSession {
  const perResponse = usageGranularity(meta.connectorId) === 'per-response';
  return {
    meta,
    state: derived.state,
    lastWriteMs,
    ...(derived.stateSinceMs !== undefined ? { stateSinceMs: derived.stateSinceMs } : {}),
    ...(derived.openTool ? { openTool: derived.openTool } : {}),
    subagents: derived.subagents,
    runs: derived.runs,
    ...(derived.lastText !== undefined ? { lastText: derived.lastText } : {}),
    ...(derived.toolErrors !== undefined ? { toolErrors: derived.toolErrors } : {}),
    usageGranularity: usageGranularity(meta.connectorId),
    activity: trimMinutes(derived.activity, nowMs, ACTIVITY_WINDOW_MS),
    ...(derived.compactions ? { compactions: derived.compactions } : {}),
    ...(perResponse ? { costMinutes: trimMinutes(costMinutes ?? [], nowMs, COST_KEEP_MS) } : {}),
  };
}

interface DetailEntry {
  fingerprint: string;
  windowMs: number;
  hasRuns: boolean;
  anyActive: boolean;
  derived: LiveStateResult;
  messages: AgentMessage[];
  derivedAtMs: number;
}

// Derived outputs only, never threads; bounded because any indexed session can be asked for.
const DETAIL_CACHE_MAX = 20;
const detailCache = new Map<string, DetailEntry>();

async function detailFor(
  meta: SessionMeta,
  candidate: LiveCandidate,
  nowMs: number,
  windowMs: number,
): Promise<DetailEntry> {
  const hit = detailCache.get(candidate.id);
  if (hit) {
    const age = nowMs - hit.derivedAtMs;
    if (age >= 0 && age < REDERIVE_FLOOR_MS && hit.windowMs === windowMs) return hit;
    // Only a running subagent's liveness reads the clock; a session with none
    // changes only when its fingerprint does.
    if (
      age >= 0 &&
      hit.fingerprint === candidate.fingerprint &&
      (!hit.hasRuns || (hit.windowMs === windowMs && (!hit.anyActive || age <= RUNS_CACHE_MAX_AGE_MS)))
    ) {
      return hit;
    }
  }
  const { thread, runs, endedAt } = await loadThread(meta, candidate);
  const derived = deriveLiveState({ connectorId: meta.connectorId, thread, runs, nowMs, windowMs, endedAt });
  const messages = buildAgentMessages({
    connectorId: meta.connectorId,
    thread,
    runs,
    signals: connectorById(meta.connectorId).interAgentSignals,
    activeAgentIds: new Set(derived.runs.filter((r) => r.active).map((r) => r.agentId)),
  });
  const entry = {
    fingerprint: candidate.fingerprint,
    windowMs,
    hasRuns: runs.length > 0,
    anyActive: derived.runs.some((r) => r.active),
    derived, messages,
    derivedAtMs: nowMs,
  };
  detailCache.delete(candidate.id);
  detailCache.set(candidate.id, entry);
  while (detailCache.size > DETAIL_CACHE_MAX) detailCache.delete(detailCache.keys().next().value as string);
  return entry;
}

// A session outside the snapshot is looked up in the index; the answer only changes with a reindex.
const FALLBACK_CACHE_MAX = 20;
const fallbackCache = new Map<string, { version: number; files: SnapshotFile[]; row: Record<string, unknown> }>();

/** The session's files and row from the snapshot, else straight from the index. */
async function findCandidate(
  snap: LiveSnapshot,
  id: string,
): Promise<{ meta: SessionMeta; candidate: LiveCandidate } | null> {
  let files = snap.files.get(id);
  let row = snap.sessionRows.get(id);
  if (!files || !row) {
    const version = getDataVersion();
    let cached = fallbackCache.get(id);
    if (!cached || cached.version !== version) {
      const conn = await getConnection();
      const fileRows = await queryRows(
        conn,
        `SELECT path, connector_id, mtime_ms FROM files WHERE session_id = ${sqlString(id)}`,
      );
      const sessionRows = await queryRows(conn, `SELECT * FROM sessions WHERE id = ${sqlString(id)}`);
      if (fileRows.length === 0 || sessionRows.length === 0) return null;
      cached = {
        version,
        files: fileRows.map((r) => ({
          path: String(r.path),
          connector_id: r.connector_id,
          mtime_ms: Number(r.mtime_ms),
        })),
        row: sessionRows[0]!,
      };
      fallbackCache.delete(id);
      fallbackCache.set(id, cached);
      while (fallbackCache.size > FALLBACK_CACHE_MAX) fallbackCache.delete(fallbackCache.keys().next().value as string);
    }
    ({ files, row } = cached);
  }
  const { fingerprint, lastModifiedMs } = fingerprintFromRows(files);
  return { meta: rowToSessionMeta(row), candidate: { id, fingerprint, lastModifiedMs, files } };
}

async function deriveFor(
  meta: SessionMeta,
  candidate: LiveCandidate,
  nowMs: number,
  windowMs: number,
  full: boolean,
): Promise<LiveStateResult> {
  const cache = full ? caches.full : caches.default;
  const hit = cache.get(candidate.id);
  if (hit) {
    const age = nowMs - hit.derivedAtMs;
    if (age >= 0 && age < REDERIVE_FLOOR_MS && hit.windowMs === windowMs) return hit.result;
    if (
      age >= 0 &&
      hit.fingerprint === candidate.fingerprint &&
      (!hit.hasRuns || (hit.windowMs === windowMs && age <= RUNS_CACHE_MAX_AGE_MS))
    ) {
      return hit.result;
    }
  }
  const { thread, runs, endedAt } = await loadThread(meta, candidate);
  const result = deriveLiveState({
    connectorId: meta.connectorId,
    thread,
    runs,
    nowMs,
    windowMs,
    endedAt,
    full,
  });
  cache.set(candidate.id, {
    fingerprint: candidate.fingerprint,
    windowMs,
    hasRuns: runs.length > 0,
    result,
    derivedAtMs: nowMs,
  });
  return result;
}

/** Sends the body with a weak ETag, or 304 when the client already holds it. */
function sendWithEtag(req: FastifyRequest, reply: FastifyReply, body: unknown) {
  const payload = JSON.stringify(body);
  const etag = `W/"${createHash('sha1').update(payload).digest('hex')}"`;
  reply.header('ETag', etag).header('Cache-Control', 'no-cache');
  if (req.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.type('application/json; charset=utf-8').send(payload);
}

export async function registerLiveRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { windowMin?: string } }>(
    '/api/live/count',
    async (req): Promise<LiveCountResponse> => {
      const { windowMinutes, windowMs } = windowMsFrom(req.query.windowMin);
      const live = findLiveSessions(await getLiveSnapshot(), Date.now(), windowMs);
      return { windowMinutes, count: live.length };
    },
  );

  app.get<{ Querystring: { windowMin?: string; detail?: string } }>(
    '/api/live',
    async (req, reply) => {
      const { windowMinutes, windowMs } = windowMsFrom(req.query.windowMin);
      const full = req.query.detail === 'full';
      const nowMs = Date.now();
      const snap = await getLiveSnapshot();
      const live = findLiveSessions(snap, nowMs, windowMs);

      // Pruned against the widest window, not this request's: a narrow-window
      // poller would otherwise evict what a wider-window client just derived.
      const widestMs = Math.max(...LIVE_WINDOW_MINUTES) * 60_000;
      const liveIds = new Set(
        (windowMs === widestMs ? live : findLiveSessions(snap, nowMs, widestMs)).map((c) => c.id),
      );
      for (const cache of [caches.default, caches.full]) {
        for (const id of cache.keys()) if (!liveIds.has(id)) cache.delete(id);
      }

      const kept = live.slice(0, LIVE_CAP);
      const metas = new Map<string, SessionMeta>();
      for (const c of kept) {
        const row = snap.sessionRows.get(c.id);
        if (row) metas.set(c.id, rowToSessionMeta(row));
      }

      const sessions: LiveSession[] = [];
      for (const candidate of kept) {
        const meta = metas.get(candidate.id);
        if (!meta) continue;
        let derived: LiveStateResult;
        try {
          derived = await deriveFor(meta, candidate, nowMs, windowMs, full);
        } catch (err) {
          req.log.warn({ sessionId: candidate.id, err: (err as Error).name }, 'live state derivation failed');
          derived = UNKNOWN_STATE;
        }
        sessions.push(toLiveSession(meta, candidate.lastModifiedMs, derived, nowMs, snap.costMinutes.get(candidate.id)));
      }

      const body: LiveResponse = {
        windowMinutes,
        sessions,
        truncated: live.length - kept.length,
        finished: findFinishedSessions(snap, nowMs, windowMs, new Set(live.map((c) => c.id))),
      };
      return sendWithEtag(req, reply, body);
    },
  );

  app.get<{ Params: { sessionId: string }; Querystring: { windowMin?: string } }>(
    '/api/live/:sessionId',
    async (req, reply) => {
      const snap = await getLiveSnapshot();
      const found = await findCandidate(snap, req.params.sessionId);
      if (!found) return reply.code(404).send({ error: 'Session not found' });
      const { meta, candidate } = found;
      const { windowMs } = windowMsFrom(req.query.windowMin);
      const nowMs = Date.now();
      let entry: DetailEntry;
      try {
        entry = await detailFor(meta, candidate, nowMs, windowMs);
      } catch (err) {
        req.log.warn({ sessionId: candidate.id, err: (err as Error).name }, 'live detail derivation failed');
        entry = { fingerprint: '', windowMs, hasRuns: false, anyActive: false, derived: UNKNOWN_STATE, messages: [], derivedAtMs: 0 };
      }
      const body: LiveSessionDetail = {
        session: toLiveSession(meta, candidate.lastModifiedMs, entry.derived, nowMs, snap.costMinutes.get(candidate.id)),
        messages: entry.messages.slice(-DETAIL_MESSAGES_MAX),
        messageSignal: agentMessageSignal(meta.connectorId),
      };
      return sendWithEtag(req, reply, body);
    },
  );
}
