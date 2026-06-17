import { useEffect, useRef, useState } from 'react';
import type { ResumeInfo } from '@claudescope/shared';

/** A copy-paste command line with its own Copy button. */
function CommandRow({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; ignore */
    }
  };
  return (
    <div className="tv-continue__cmd">
      <code className="tv-continue__cmd-text">{command}</code>
      <button type="button" className="tv-linkbtn" onClick={copy}>
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * "Continue" dropdown: the command to reopen this session in the agent's own CLI,
 * for the user to copy and run in their terminal. Rendered only when the
 * session's connector exposes a resume command.
 */
export function ContinueMenu({ resume }: { resume: ResumeInfo }) {
  const [open, setOpen] = useState(false);
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

  return (
    <details ref={ref} className="tv-continue" open={open}>
      <summary
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        ▷ Continue
      </summary>
      <div className="tv-continue__menu">
        <p className="tv-continue__hint">Run this in your terminal to resume the session:</p>
        <CommandRow command={resume.resumeCommand} />
        {resume.forkCommand ? (
          <>
            <p className="tv-continue__hint">Or fork into a new session, leaving this one untouched:</p>
            <CommandRow command={resume.forkCommand} />
          </>
        ) : null}
      </div>
    </details>
  );
}
