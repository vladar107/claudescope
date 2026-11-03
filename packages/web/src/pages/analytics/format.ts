/** Number/label formatting helpers local to the analytics page. */

import type { AnalyticsGroupBy } from '@claudescope/shared';
import { agentLabel, formatCount, formatCost } from '../../components/index.js';

export { formatCount, formatCost };

/** Format a [0,1] ratio as a percentage string, e.g. 0.734 -> "73.4%". */
export function formatPct(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0%';
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Per-response cost: keep sub-cent precision (e.g. $0.0011) where formatCost rounds away. */
export function formatPerCost(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 0.01) return formatCost(n);
  return `$${n.toFixed(4)}`;
}

/**
 * Shorten a group key for axis/legend display. Project slugs can be long, so we
 * keep the trailing path-like segment; model ids drop the date suffix; day keys
 * pass through unchanged.
 */
export function shortKey(key: string, groupBy: AnalyticsGroupBy): string {
  if (!key) return '(none)';
  if (groupBy === 'day') return key;
  if (groupBy === 'agent') return agentLabel(key);
  if (groupBy === 'model') {
    // strip a trailing -YYYYMMDD date stamp if present (e.g. opus-4-8-20251101)
    return key.replace(/-\d{8}$/, '');
  }
  // project slug: show the last 2 dash-segments for a recognizable tail
  const parts = key.split('-').filter(Boolean);
  if (parts.length <= 2) return key;
  return parts.slice(-2).join('-');
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The browser's IANA time zone, sent with analytics queries so days are local. */
export const TIME_ZONE = browserTimeZone();

/** Today's date (YYYY-MM-DD) in {@link TIME_ZONE}. */
export function todayInTimeZone(): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((candidate) => candidate.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
