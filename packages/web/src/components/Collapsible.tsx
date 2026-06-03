import { useState, type ReactNode } from 'react';

/**
 * Generic collapsible panel used as the shell for tool and thinking blocks.
 * Uncontrolled by default (`defaultOpen`); pass `open` + `onToggle` to control.
 */
export interface CollapsibleProps {
  /** Bold title in the header. */
  title: ReactNode;
  /** Optional secondary text (e.g. tool id), shown muted/mono. */
  subtitle?: ReactNode;
  /** Optional leading icon/glyph. */
  icon?: ReactNode;
  /** Extra header content rendered right-aligned (chips, badges, status). */
  headerExtra?: ReactNode;
  /** Initial open state when uncontrolled. */
  defaultOpen?: boolean;
  /** Controlled open state. */
  open?: boolean;
  /** Controlled toggle handler. */
  onToggle?: (open: boolean) => void;
  /** Extra className(s) on the root (e.g. variant modifiers). */
  className?: string;
  children: ReactNode;
}

export function Collapsible({
  title,
  subtitle,
  icon,
  headerExtra,
  defaultOpen = false,
  open,
  onToggle,
  className,
  children,
}: CollapsibleProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;

  const toggle = () => {
    const next = !isOpen;
    if (!isControlled) setInternalOpen(next);
    onToggle?.(next);
  };

  const rootClass = [
    'tv-collapsible',
    isOpen ? 'is-open' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClass}>
      <button
        type="button"
        className="tv-collapsible__header"
        aria-expanded={isOpen}
        onClick={toggle}
      >
        <span className="tv-collapsible__chevron" aria-hidden="true">
          ▶
        </span>
        {icon ? <span className="tv-collapsible__icon">{icon}</span> : null}
        <span className="tv-collapsible__title">{title}</span>
        {subtitle ? <span className="tv-collapsible__subtitle">{subtitle}</span> : null}
        <span className="tv-collapsible__spacer" />
        {headerExtra}
      </button>
      {isOpen ? <div className="tv-collapsible__body">{children}</div> : null}
    </div>
  );
}
