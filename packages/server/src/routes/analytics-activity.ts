/**
 * GET /api/analytics/activity — a punchcard of user prompts by local
 * day-of-week × hour, plus an all-time prompt streak.
 *
 * Local time: `events.ts` is stored UTC-naive, so the client sends its current
 * UTC offset in minutes and the server shifts with `to_minutes()`. This avoids a
 * DuckDB ICU dependency; the (DST-imperfect) fixed offset is fine for a
 * "when do I usually work" view. The heatmap honors the `from`/`to` filter; the
 * streak is always all-time (a current streak only means anything vs. today).
 */
import type { FastifyInstance } from 'fastify';
import type { ActivityCell, ActivityResponse, StreakInfo } from '@claudescope/shared';
import { getConnection, queryRows, sqlString } from '../db/duckdb.js';
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

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function registerActivityRoute(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { from?: string; to?: string; tzOffsetMinutes?: string; today?: string };
  }>('/api/analytics/activity', async (req): Promise<ActivityResponse> => {
    const conn = await getConnection();
    const offset = clampOffset(req.query.tzOffsetMinutes);
    const today = ISO_DAY.test(req.query.today ?? '') ? (req.query.today as string) : '';
    const localTs = `(e.ts + to_minutes(${offset}))`;

    // Heatmap: honors the date filter (matches the rest of the page).
    // Exclude sidechain rows (subagent-internal user turns) and fork-copy rows
    // (copied when a session is forked/resumed) so only genuine human prompts
    // are counted — sidechain + fork copies would otherwise inflate by ~2.6×.
    const filters: string[] = ["e.type = 'user'", 'NOT e.is_sidechain', 'e.forked_from_session_id IS NULL'];
    if (req.query.from) filters.push(`e.ts >= ${sqlString(req.query.from)}::TIMESTAMP`);
    if (req.query.to) filters.push(`e.ts <= ${sqlString(req.query.to)}::TIMESTAMP`);
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
