/** Number/label formatting helpers local to the analytics page. */

import type { AnalyticsGroupBy } from '@claudescope/shared';
import { agentLabel, formatCount, formatCost } from '../../components/index.js';

export { formatCount, formatCost };

/** Format a [0,1] ratio as a percentage string, e.g. 0.734 -> "73.4%". */
export function formatPct(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0%';
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Compact wall-clock duration: 0 → "—", else "2h 10m" / "5m" / "30s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
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
