import type { MessageUsage } from '@claudescope/shared';

/** Compact, locale-aware integer formatting (e.g. 12345 -> "12.3K"). */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`;
}

export interface TokenChipsProps {
  /** A usage object (assistant message) — chips are derived from its fields. */
  usage?: MessageUsage;
  /**
   * Or pass explicit token totals (e.g. session/project aggregates) instead of
   * a raw usage object. When both are given, explicit props win.
   */
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
  /** Show a single "total tokens" chip instead of the breakdown. */
  totalOnly?: boolean;
  total?: number;
}

/**
 * Renders token counts as small pill chips. Accepts either a raw `usage`
 * object or explicit aggregate numbers. Zero-valued breakdown chips are hidden
 * to keep dense lists readable.
 */
export function TokenChips(props: TokenChipsProps) {
  const input = props.input ?? props.usage?.input_tokens ?? 0;
  const output = props.output ?? props.usage?.output_tokens ?? 0;
  const cacheWrite = props.cacheWrite ?? props.usage?.cache_creation_input_tokens ?? 0;
  const cacheRead = props.cacheRead ?? props.usage?.cache_read_input_tokens ?? 0;

  if (props.totalOnly) {
    const total = props.total ?? input + output + cacheWrite + cacheRead;
    return (
      <span className="tv-chips">
        <span className="tv-chip">
          <span className="tv-chip__label">tok</span>
          <span className="tv-chip__value">{formatCount(total)}</span>
        </span>
      </span>
    );
  }

  // Compact form: colored dots for input/output (matching the thread's token
  // legend), then grouped cache (read · write), shown only when non-zero.
  return (
    <span className="tv-tok">
      <span className="tv-tok__seg">
        <span className="tv-tok__dot tv-tok__dot--in" />
        {formatCount(input)}
      </span>
      <span className="tv-tok__seg">
        <span className="tv-tok__dot tv-tok__dot--out" />
        {formatCount(output)}
      </span>
      {cacheRead > 0 || cacheWrite > 0 ? (
        <span className="tv-tok__seg tv-tok__seg--cache">
          <span className="tv-tok__dot tv-tok__dot--cache" />
          cache {formatCount(cacheRead)} · {formatCount(cacheWrite)}
        </span>
      ) : null}
    </span>
  );
}
