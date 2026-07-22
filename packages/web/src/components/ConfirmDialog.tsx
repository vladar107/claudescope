/**
 * Minimal confirmation modal for destructive actions (the app's first — no
 * dialog library). Renders a fixed overlay + a `tv-card` panel; Escape or an
 * overlay click cancels; focus lands on Cancel so Enter never confirms by
 * accident.
 */

import { useEffect, useRef } from 'react';

interface ConfirmDialogProps {
  title: string;
  /** Body copy — spell out exactly what will happen. */
  children: React.ReactNode;
  confirmLabel: string;
  /** Style the confirm button as destructive (danger) or primary. */
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="tv-dialog-overlay" onClick={onCancel} role="presentation">
      <div
        className="tv-card tv-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="tv-dialog__title">{title}</h2>
        <div className="tv-dialog__body">{children}</div>
        <div className="tv-dialog__actions">
          <button ref={cancelRef} type="button" className="tv-btn tv-btn--secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'tv-btn tv-btn--danger' : 'tv-btn tv-btn--primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
