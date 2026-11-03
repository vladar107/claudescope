/**
 * Index snapshot for the Live tab. The shared DuckDB connection runs one
 * statement at a time, so a live request that queried it directly would queue
 * behind whatever long statement an indexer pass is executing. Instead the
 * live routes read this in-memory copy of the recently-written sessions' `files`
 * and `sessions` rows, refreshed stale-while-revalidate: only the very first
 * request awaits a build; after a reindex bumps `dataVersion`, one refresh runs
 * and requests wait for it only briefly before serving the previous snapshot.
 *
 * The snapshot is a superset of every later request's candidates: its floor
 * leaves room for the widest window plus the reindex-interval lag of `files`
 * mtimes, a later request's floor is only higher, and a session that newly
 * becomes active must be re-indexed first, which invalidates the snapshot.
 */

import { LIVE_WINDOW_MINUTES, type LiveMinuteCost } from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import { reindexIntervalMs } from '../settings.js';
import { usageGranularity } from './agent-capabilities.js';
import { usageRowsSql } from './analytics-metrics.js';
import { getDataVersion } from './index.js';

export interface SnapshotFile {
  path: string;
  connector_id: unknown;
  mtime_ms: number;
}

export interface LiveSnapshot {
  dataVersion: number;
  files: Map<string, SnapshotFile[]>;
  sessionRows: Map<string, Record<string, unknown>>;
  /** Per-minute cost of per-response sessions, from the build time's last hour (+ reindex lag). */
  costMinutes: Map<string, LiveMinuteCost[]>;
}

const MAX_WINDOW_MS = Math.max(...(LIVE_WINDOW_MINUTES as readonly number[])) * 60_000;

/** How far back per-minute cost is kept for each live session (the burn rate reads the last 10 minutes). */
export const COST_KEEP_MS = 60 * 60_000;

let snapshot: LiveSnapshot | null = null;
let building: Promise<LiveSnapshot> | null = null;

async function build(): Promise<LiveSnapshot> {
  const version = getDataVersion();
  const floor = Math.floor(Date.now() - MAX_WINDOW_MS - reindexIntervalMs());
  const conn = await getConnection();
  const fileRows = await queryRows(
    conn,
    `SELECT session_id, path, connector_id, mtime_ms FROM files
     WHERE session_id IN (
       SELECT session_id FROM files WHERE session_id IS NOT NULL
       GROUP BY session_id HAVING max(mtime_ms) >= ${floor}
     )`,
  );
  const files = new Map<string, SnapshotFile[]>();
  for (const r of fileRows) {
    const id = String(r.session_id);
    const entry: SnapshotFile = {
      path: String(r.path),
      connector_id: r.connector_id,
      mtime_ms: Number(r.mtime_ms),
    };
    const list = files.get(id);
    if (list) list.push(entry);
    else files.set(id, [entry]);
  }

  const sessionRows = new Map<string, Record<string, unknown>>();
  if (files.size > 0) {
    const rows = await queryRows(
      conn,
      `SELECT * FROM sessions WHERE id IN (${[...files.keys()].map(sqlString).join(', ')})`,
    );
    for (const row of rows) sessionRows.set(String(row.id), row);
  }

  // One grouped query per build, never per request; `ts` is UTC-naive, which
  // epoch_ms() reads as UTC.
  const costMinutes = new Map<string, LiveMinuteCost[]>();
  const costIds = [...sessionRows]
    .filter(([, row]) => usageGranularity(String(row.connector_id ?? '')) === 'per-response')
    .map(([id]) => id);
  if (costIds.length > 0) {
    const costFloor = Math.floor(Date.now() - COST_KEEP_MS - reindexIntervalMs());
    const rows = await queryRows(
      conn,
      `SELECT e.session_id AS session_id,
              CAST(epoch_ms(e.ts) // 60000 AS BIGINT) AS minute,
              SUM(e.cost_usd) AS cost_usd
       FROM events e
       WHERE e.session_id IN (${costIds.map(sqlString).join(', ')})
         AND ${usageRowsSql('e')}
         AND e.cost_usd > 0
         AND e.ts >= epoch_ms(${costFloor}::BIGINT)
       GROUP BY 1, 2
       ORDER BY 1, 2`,
    );
    for (const r of rows) {
      const id = String(r.session_id);
      const entry = { minute: Number(r.minute), costUsd: Number(r.cost_usd) };
      const list = costMinutes.get(id);
      if (list) list.push(entry);
      else costMinutes.set(id, [entry]);
    }
  }
  return { dataVersion: version, files, sessionRows, costMinutes };
}

function startBuild(): Promise<LiveSnapshot> {
  building ??= build()
    .then((s) => {
      snapshot = s;
      return s;
    })
    .finally(() => {
      building = null;
    });
  return building;
}

/** How long a request waits for the refresh a reindex just triggered. */
export const SNAPSHOT_REFRESH_WAIT_MS = 250;

/**
 * The current snapshot. Awaits only the first build. After a reindex it races
 * the (deduped) refresh against a short timeout — a pass just ended, so the
 * connection is usually idle and the new snapshot lands in time — and falls
 * back to the previous snapshot while the refresh finishes in the background.
 */
export async function getLiveSnapshot(): Promise<LiveSnapshot> {
  if (!snapshot) return startBuild();
  if (snapshot.dataVersion === getDataVersion()) return snapshot;
  const previous = snapshot;
  const refresh = startBuild();
  refresh.catch((err) => {
    console.warn('claudescope: live snapshot refresh failed:', (err as Error).name);
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<LiveSnapshot>((resolve) => {
    timer = setTimeout(() => resolve(previous), SNAPSHOT_REFRESH_WAIT_MS);
  });
  try {
    return await Promise.race([refresh, timeout]);
  } catch {
    return previous;
  } finally {
    clearTimeout(timer);
  }
}
