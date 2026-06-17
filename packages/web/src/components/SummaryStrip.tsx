import type { ReactNode } from 'react';

export interface SummaryItem {
  label: string;
  value: ReactNode;
}

/**
 * A compact row of stat tiles (label + bold value) that anchors the top of a
 * list view. Shared by the Browse portfolio header and the project detail
 * header so the two read as the same pattern at different altitudes.
 */
export function SummaryStrip({ items }: { items: SummaryItem[] }) {
  return (
    <div className="tv-summary">
      {items.map((it) => (
        <div key={it.label} className="tv-summary__tile">
          <span className="tv-summary__label">{it.label}</span>
          <span className="tv-summary__value">{it.value}</span>
        </div>
      ))}
    </div>
  );
}
