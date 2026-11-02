/**
 * GET /api/live — sessions written to within the live window, each with a state
 * inferred from its transcript tail. GET /api/live/count — the same selection,
 * stat-only, for the nav badge: it never loads or parses a transcript.
 *
 * Selection is two-step. The `files` table narrows candidates cheaply (its
 * mtimes lag the disk by up to one reindex interval, hence the slack), then a
 * live stat through the owning connector confirms them. A newly active session
 * is therefore picked up within one reindex interval (longer while the indexer
 * is paused); once a candidate, its live stats track the transcript with no
 * further reindex.
 */

import type { FastifyInstance } from 'fastify';
import type { LiveCountResponse, LiveResponse, LiveSession, SessionMeta } from '@claudescope/shared';
import { LIVE_DEFAULT_WINDOW_MINUTES, LIVE_WINDOW_MINUTES } from '@claudescope/shared';
import { connectorById } from '../connectors/registry.js';
import { hasPromptSizedUsage, usageGranularity } from '../data/agent-capabilities.js';
import { fingerprintFromRows } from '../data/fingerprint.js';
import { deriveLiveState, type LiveStateResult } from '../data/live-state.js';
import { assembleThread, buildSubagentRuns } from '../data/parser.js';
import { getLiveSnapshot, type LiveSnapshot, type SnapshotFile } from '../data/live-snapshot.js';
import { reindexIntervalMs } from '../settings.js';
import { rowToSessionMeta } from './sessions.js';

const LIVE_CAP = 20;
// Only subagent-run liveness reads the clock and window, so a result for a
// session with runs ages out well inside the client's 30 s poll; one without
// runs is valid for as long as its fingerprint matches.
const RUNS_CACHE_MAX_AGE_MS = 10_000;

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

// Derived results only — never threads or transcript text.
const cache = new Map<string, CacheEntry>();

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

async function deriveFor(
  meta: SessionMeta,
  candidate: LiveCandidate,
  nowMs: number,
  windowMs: number,
): Promise<LiveStateResult> {
  const hit = cache.get(candidate.id);
  if (
    hit &&
    hit.fingerprint === candidate.fingerprint &&
    (!hit.hasRuns ||
      (hit.windowMs === windowMs && nowMs - hit.derivedAtMs <= RUNS_CACHE_MAX_AGE_MS))
  ) {
    return hit.result;
  }
  const paths = candidate.files.map((f) => f.path);
  const { mainEvents, subagents, endedAt } = await connectorById(
    String(candidate.files[0]?.connector_id ?? ''),
  ).loadSession(candidate.id, paths, { resolveImages: false });
  const assemble = { deriveContextSizes: hasPromptSizedUsage(meta.connectorId) };
  const thread = assembleThread(mainEvents, assemble);
  const runs = buildSubagentRuns(thread, subagents, assemble);
  const result = deriveLiveState({
    connectorId: meta.connectorId,
    thread,
    runs,
    nowMs,
    windowMs,
    endedAt,
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

export async function registerLiveRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { windowMin?: string } }>(
    '/api/live/count',
    async (req): Promise<LiveCountResponse> => {
      const { windowMinutes, windowMs } = windowMsFrom(req.query.windowMin);
      const live = findLiveSessions(await getLiveSnapshot(), Date.now(), windowMs);
      return { windowMinutes, count: live.length };
    },
  );

  app.get<{ Querystring: { windowMin?: string } }>(
    '/api/live',
    async (req): Promise<LiveResponse> => {
      const { windowMinutes, windowMs } = windowMsFrom(req.query.windowMin);
      const nowMs = Date.now();
      const snap = await getLiveSnapshot();
      const live = findLiveSessions(snap, nowMs, windowMs);

      const liveIds = new Set(live.map((c) => c.id));
      for (const id of cache.keys()) if (!liveIds.has(id)) cache.delete(id);

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
          derived = await deriveFor(meta, candidate, nowMs, windowMs);
        } catch (err) {
          req.log.warn({ sessionId: candidate.id, err: (err as Error).name }, 'live state derivation failed');
          derived = { state: 'unknown', subagents: { running: 0, done: 0 } };
        }
        sessions.push({
          meta,
          state: derived.state,
          lastWriteMs: candidate.lastModifiedMs,
          ...(derived.stateSinceMs !== undefined ? { stateSinceMs: derived.stateSinceMs } : {}),
          ...(derived.openTool ? { openTool: derived.openTool } : {}),
          subagents: derived.subagents,
          usageGranularity: usageGranularity(meta.connectorId),
        });
      }

      return { windowMinutes, sessions, truncated: live.length - kept.length };
    },
  );
}
