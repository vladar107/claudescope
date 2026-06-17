import { useEffect, useRef, useState } from 'react';

/** A capped row of model chips, shared by the session list and the header. */

/** Shorten a model id for chip display (drops the date suffix). */
export function shortModel(model: string): string {
  if (model === '<synthetic>') return 'synthetic';
  // e.g. "claude-opus-4-8-20250101" -> "opus-4-8"
  const stripped = model.replace(/^claude-/, '');
  const m = /^([a-z]+-\d+-\d+)/.exec(stripped);
  return m?.[1] ?? stripped;
}

export interface ModelChipsProps {
  models: string[];
  /** Max chips to show before collapsing the rest into a clickable "+N" chip. */
  max?: number;
}

/**
 * Renders model ids as chips, capped at `max` (default 3). Sessions can span
 * 1–5+ models; any beyond the cap collapse into a "+N" chip that opens a small
 * popover listing the rest, so a busy session stays a single tidy line.
 */
export function ModelChips({ models, max = 3 }: ModelChipsProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (models.length === 0) return null;
  const shown = models.slice(0, max);
  const rest = models.slice(max);

  return (
    <span className="tv-chips">
      {shown.map((m) => (
        <span key={m} className="tv-chip tv-chip--model">
          {shortModel(m)}
        </span>
      ))}
      {rest.length > 0 ? (
        <span className="tv-modelchips__more-wrap" ref={ref}>
          <button
            type="button"
            className="tv-chip tv-chip--model tv-chip--more"
            aria-expanded={open}
            aria-label={`Show ${rest.length} more model${rest.length === 1 ? '' : 's'}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen((o) => !o);
            }}
          >
            +{rest.length}
          </button>
          {open ? (
            <span className="tv-modelchips__pop">
              {rest.map((m) => (
                <span key={m} className="tv-chip tv-chip--model">
                  {shortModel(m)}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
