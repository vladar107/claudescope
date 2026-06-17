import { useEffect, useRef, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import type { SessionDetailResponse } from '@claudescope/shared';
import { sessionToMarkdown } from './export.js';

/** An "Export" dropdown: download the session as Markdown, or copy it. */
export function ExportMenu({ data }: { data: SessionDetailResponse }) {
  const [open, setOpen] = useState(false);
  const [redact, setRedact] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);

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

  const filename = `${(data.meta.title || data.meta.id).replace(/[^\w.-]+/g, '-').slice(0, 60)}.md`;

  const download = () => {
    const md = sessionToMarkdown(data, { redact });
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setOpen(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sessionToMarkdown(data, { redact }));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; ignore */
    }
  };

  return (
    <details ref={ref} className="tv-export" open={open}>
      <summary
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        <Download size={14} aria-hidden="true" /> Export
      </summary>
      <div className="tv-export__menu">
        <div className="tv-export__head">
          <Download size={16} aria-hidden="true" />
          <strong>Export session</strong>
          <span className="tv-chip tv-export__fmt">Markdown ·md</span>
        </div>

        <label className="tv-export__redact">
          <span className="tv-export__redact-top">
            <input
              type="checkbox"
              className="tv-switch__input"
              checked={redact}
              onChange={(e) => setRedact(e.target.checked)}
            />
            <span className="tv-switch" aria-hidden="true" />
            <strong>Redact paths &amp; secrets</strong>
          </span>
          <span className="tv-export__redact-desc">
            Replaces home-dir paths with <code>~</code> and masks likely tokens / keys before
            export. Best-effort — an unrecognized secret can still slip through.
          </span>
          <span className="tv-export__example tv-mono" aria-hidden="true">
            /Users/you/… → ~/… · sk-… → «redacted-key»
          </span>
        </label>

        <div className="tv-export__actions">
          <button type="button" className="tv-btn tv-btn--primary tv-export__download" onClick={download}>
            <Download size={14} aria-hidden="true" /> Download .md
          </button>
          <button type="button" className="tv-btn tv-btn--secondary" onClick={copy}>
            {copied ? (
              'Copied!'
            ) : (
              <>
                <Copy size={14} aria-hidden="true" /> Copy
              </>
            )}
          </button>
        </div>
      </div>
    </details>
  );
}
