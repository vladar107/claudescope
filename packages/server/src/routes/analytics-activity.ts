/**
 * GET /api/analytics/activity — a punchcard of user prompts by local
 * day-of-week × hour, plus an all-time prompt streak.
 *
 * Local time: `events.ts` is stored UTC-naive. An IANA `timeZone` localizes
 * every event with DuckDB/ICU, including historical DST changes. The old fixed
 * `tzOffsetMinutes` remains a compatibility fallback when no timezone is sent.
 * The heatmap honors the `from`/`to` filter; the streak is always all-time (a
 * current streak only means anything vs. today).
 */
import type { FastifyInstance } from 'fastify';
import type { ActivityCell, ActivityResponse, StreakInfo } from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
import {
  analyticsTimeZone,
  localTimestampSql,
  scopeFilters,
} from '../data/analytics-scope.js';
import { isoDayParam } from '../params.js';
import { readRow } from '../db/row.js';

const DAY_MS = 86_400_000;
const dayNum = (s: string): number => Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY_MS);

/** All-time prompt streak from the set of active local days and the local today. */
export function computeStreaks(activeDays: string[], today: string): StreakInfo {
  const uniq = [...new Set(activeDays)].filter(Boolean).sort();
  if (uniq.length === 0) return { current: 0, longest: 0, lastActiveDay: null };

  // longest consecutive run
  let longest = 1;
  let run = 1;
  for (let i = 1; i < uniq.length; i++) {
    run = dayNum(uniq[i]!) - dayNum(uniq[i - 1]!) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  // current run ending at the last active day, only "alive" if that day is
  // today or yesterday relative to `today`.
  const lastActiveDay = uniq[uniq.length - 1]!;
  const gap = dayNum(today) - dayNum(lastActiveDay);
  let current = 0;
  if (gap <= 1 && gap >= 0) {
    current = 1;
    for (let i = uniq.length - 1; i > 0; i--) {
      if (dayNum(uniq[i]!) - dayNum(uniq[i - 1]!) === 1) current++;
      else break;
    }
  }
  return { current, longest, lastActiveDay };
}

function clampOffset(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '0', 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-840, Math.min(840, n));
}

export async function registerActivityRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: {
      from?: string;
      to?: string;
      timeZone?: string;
      tzOffsetMinutes?: string;
      today?: string;
    };
  }>('/api/analytics/activity', async (req): Promise<ActivityResponse> => {
    const conn = await getConnection();
    const hasTimeZone = Boolean(req.query.timeZone?.trim());
    const timeZone = hasTimeZone
      ? await analyticsTimeZone(conn, req.query.timeZone)
      : undefined;
    const offset = clampOffset(req.query.tzOffsetMinutes);
    const localTs = timeZone
      ? localTimestampSql('e.ts', timeZone)
      : `(e.ts + to_minutes(${offset}))`;
    let today = isoDayParam(req.query.today);
    if (!today) {
      if (timeZone) {
        const todayRows = await queryRows(
          conn,
          `SELECT strftime(timezone(${sqlString(timeZone)}, current_timestamp), '%Y-%m-%d') AS day`,
        );
        today = readRow(todayRows[0] ?? {}, 'activity-today').str('day');
      } else {
        today = new Date(Date.now() + offset * 60_000).toISOString().slice(0, 10);
      }
    }

    // Heatmap: honors the date filter (matches the rest of the page).
    // Exclude sidechain rows (subagent-internal user turns) and fork-copy rows
    // (copied when a session is forked/resumed) so only genuine human prompts
    // are counted — sidechain + fork copies would otherwise inflate by ~2.6×.
    const filters: string[] = [
      "e.type = 'user'",
      'NOT e.is_sidechain',
      'e.forked_from_session_id IS NULL',
      // Shared (validated) bounds, on the event timestamp.
      ...(await scopeFilters(
        conn,
        { from: req.query.from, to: req.query.to, timeZone },
        { ts: 'e.ts' },
      )),
    ];
    const heatmapRows = await queryRows(
      conn,
      `SELECT
         CAST(extract('isodow' FROM ${localTs}) AS INTEGER) AS dow,
         CAST(extract('hour'   FROM ${localTs}) AS INTEGER) AS hour,
         count(*) AS count
       FROM events e
       WHERE ${filters.join(' AND ')}
       GROUP BY dow, hour`,
    );
    const heatmap: ActivityCell[] = heatmapRows.map((r) => {
      const rd = readRow(r, 'activity-heatmap');
      return { dow: rd.num('dow'), hour: rd.num('hour'), count: rd.num('count') };
    });

    // Streak: all-time (ignores the date filter). Same exclusions apply.
    const dayRows = await queryRows(
      conn,
      `SELECT DISTINCT strftime(${localTs}, '%Y-%m-%d') AS day
       FROM events e
       WHERE e.type = 'user'
         AND NOT e.is_sidechain
         AND e.forked_from_session_id IS NULL`,
    );
    const activeDays = dayRows
      .map((r) => readRow(r, 'activity-days').str('day'))
      .filter(Boolean);
    const streak = computeStreaks(activeDays, today);

    return { heatmap, streak };
  });
}
