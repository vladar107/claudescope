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

  return (
    <span className="tv-chips">
      <Chip className="tv-chip--input" label="in" value={input} />
      <Chip className="tv-chip--output" label="out" value={output} />
      <Chip className="tv-chip--cache" label="cw" value={cacheWrite} hideZero />
      <Chip className="tv-chip--cache" label="cr" value={cacheRead} hideZero />
    </span>
  );
}

function Chip({
  className,
  label,
  value,
  hideZero,
}: {
  className?: string;
  label: string;
  value: number;
  hideZero?: boolean;
}) {
  if (hideZero && value <= 0) return null;
  return (
    <span className={className ? `tv-chip ${className}` : 'tv-chip'}>
      <span className="tv-chip__label">{label}</span>
      <span className="tv-chip__value">{formatCount(value)}</span>
    </span>
  );
}
