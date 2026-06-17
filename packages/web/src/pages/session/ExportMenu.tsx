import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { SessionDetailResponse } from '@claudescope/shared';
import { sessionToMarkdown } from './export.js';

/** A small "Export" dropdown: download the session as Markdown, or copy it. */
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
        <label className="tv-export__opt">
          <input type="checkbox" checked={redact} onChange={(e) => setRedact(e.target.checked)} />
          Redact paths &amp; secrets
        </label>
        <div className="tv-export__actions">
          <button type="button" className="tv-linkbtn" onClick={download}>
            Download .md
          </button>
          <button type="button" className="tv-linkbtn" onClick={copy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
    </details>
  );
}
