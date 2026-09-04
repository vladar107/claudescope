import { formatCount } from '../../components/TokenChips.js';

/**
 * Small presentational helpers shared by the browse + session views.
 * Kept local to these pages (no shell files touched).
 */

/** Format an ISO timestamp as a compact local date-time, or "—" when absent. */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format an ISO timestamp as a date only. */
export function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Relative "time ago" label for recency (e.g. "3h ago", "2d ago"). */
export function timeAgo(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const ms = d.getTime();
  if (Number.isNaN(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.floor(mon / 12)}y ago`;
}

/**
 * Compact elapsed duration between two ISO timestamps, rolled up to the two
 * largest sensible units: "30s", "45m", "1h 23m", "3d 4h", "2w 4d". Keeps long
 * sessions readable (e.g. "436h 55m" → "2w 4d").
 */
export function formatDuration(startIso: string | undefined, endIso: string | undefined): string {
  if (!startIso || !endIso) return '';
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const m = min % 60;
    return m ? `${hr}h ${m}m` : `${hr}h`;
  }
  const day = Math.floor(hr / 24);
  if (day < 7) {
    const h = hr % 24;
    return h ? `${day}d ${h}h` : `${day}d`;
  }
  const week = Math.floor(day / 7);
  const d = day % 7;
  return d ? `${week}w ${d}d` : `${week}w`;
}

/**
 * Share of the model's context window used at a turn, or undefined when the
 * window (or the figure itself) is unknown — no window, no ratio.
 */
function contextRatio(
  tokens: number | null | undefined,
  window: number | null | undefined,
): number | undefined {
  if (tokens == null || window == null) return undefined;
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0) return undefined;
  return tokens / window;
}

/**
 * How hot the context is at a turn: `warm` from 80 % of the window, `hot` from
 * 95 %. The single source of the thresholds for every view that flags them.
 */
export function contextLevel(
  tokens: number | null | undefined,
  window: number | null | undefined,
): 'warm' | 'hot' | undefined {
  const ratio = contextRatio(tokens, window);
  if (ratio === undefined) return undefined;
  if (ratio >= 0.95) return 'hot';
  if (ratio >= 0.8) return 'warm';
  return undefined;
}

/**
 * "395K of 1M (39%)" — the last prompt's size against the model's window, so it
 * cannot be mistaken for the session's cumulative token total shown beside it;
 * just "395K" when the window is unknown.
 */
export function contextLabel(tokens: number, window: number | null | undefined): string {
  const pct = contextPct(tokens, window);
  return pct ? `${formatCount(tokens)} of ${formatCount(window as number)} (${pct})` : formatCount(tokens);
}

/** Context fill as a whole-percent label ("71%"), or "" when the window is unknown. */
export function contextPct(
  tokens: number | null | undefined,
  window: number | null | undefined,
): string {
  const ratio = contextRatio(tokens, window);
  return ratio === undefined ? '' : `${Math.round(ratio * 100)}%`;
}

/** Human-readable byte size (e.g. "1.3 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

// `shortModel` now lives with the shared <ModelChips> component; re-exported
// here so existing browse/session imports keep their path.
export { shortModel } from '../../components/ModelChips.js';
