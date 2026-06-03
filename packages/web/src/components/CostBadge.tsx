/** Formats a USD cost. Sub-cent values get more precision; zero is dimmed. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export interface CostBadgeProps {
  /** Cost in US dollars. */
  usd: number;
  /** Optional prefix label, e.g. "cost". */
  label?: string;
}

/** Pill badge showing a monetary cost. */
export function CostBadge({ usd, label }: CostBadgeProps) {
  const zero = !usd || usd <= 0;
  return (
    <span className={zero ? 'tv-cost-badge tv-cost-badge--zero' : 'tv-cost-badge'}>
      {label ? <span style={{ marginRight: 4, opacity: 0.7 }}>{label}</span> : null}
      {formatCost(usd)}
    </span>
  );
}
