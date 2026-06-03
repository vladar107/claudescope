/** Inline loading spinner with an optional label. */
export interface SpinnerProps {
  /** Text shown next to the spinner. */
  label?: string;
  /** Larger variant for full-page/centered loading states. */
  size?: 'sm' | 'lg';
}

export function Spinner({ label = 'Loading…', size = 'sm' }: SpinnerProps) {
  return (
    <span className={size === 'lg' ? 'tv-spinner tv-spinner--lg' : 'tv-spinner'} role="status">
      <span className="tv-spinner__circle" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </span>
  );
}
