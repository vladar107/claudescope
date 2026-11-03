import type { LiveMinuteCost, LiveSession } from '@claudescope/shared';

export const SPARK_MINUTES = 30;
const RATE_MINUTES = 10;
const BUSY_MINUTES = 5;
const MINUTE_MS = 60_000;

export const NOTIFY_KEY = 'claudescope.live.notify';

export function readNotify(): boolean {
  try {
    return window.localStorage.getItem(NOTIFY_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeNotify(on: boolean): void {
  try {
    window.localStorage.setItem(NOTIFY_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable: the choice simply does not persist */
  }
}

/** One count per minute for the last 30 minutes, oldest first; missing minutes are 0. */
export function sparkPoints(live: LiveSession, now: number): number[] {
  const cur = Math.floor(now / MINUTE_MS);
  const byMinute = new Map((live.activity ?? []).map((a) => [a.minute, a.count]));
  return Array.from({ length: SPARK_MINUTES }, (_, i) => byMinute.get(cur - (SPARK_MINUTES - 1) + i) ?? 0);
}

export function recentActivity(live: LiveSession, now: number): number {
  const cur = Math.floor(now / MINUTE_MS);
  return (live.activity ?? []).reduce(
    (sum, a) => (a.minute > cur - BUSY_MINUTES ? sum + a.count : sum),
    0,
  );
}

function sumRecent(costMinutes: LiveMinuteCost[], now: number): number {
  const cur = Math.floor(now / MINUTE_MS);
  return costMinutes.reduce((sum, c) => (c.minute > cur - RATE_MINUTES ? sum + c.costUsd : sum), 0);
}

/** Spend rate in USD/hour from the last 10 minutes; undefined when the session records no per-minute cost. */
export function burnRate(live: LiveSession, now: number): number | undefined {
  return live.costMinutes ? sumRecent(live.costMinutes, now) * 6 : undefined;
}

export function formatRate(usdPerHour: number): string {
  return `$${usdPerHour.toFixed(2)}/h`;
}
