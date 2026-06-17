import { useEffect, useRef, useState } from 'react';
import type { ResumeInfo } from '@claudescope/shared';
import { api } from '../../api/client.js';

type Mode = 'resume' | 'fork';
type LaunchState = 'idle' | 'launching' | 'launched' | 'error';

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
 * "Continue" dropdown: reopen a session in the agent's own CLI. On macOS the
 * server opens the user's default terminal running the command; elsewhere we
 * show the command to copy and run manually. Rendered only when the session's
 * connector exposes a resume command.
 */
export function ContinueMenu({ sessionId, resume }: { sessionId: string; resume: ResumeInfo }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LaunchState>('idle');
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

  const launch = async (mode: Mode) => {
    setState('launching');
    try {
      await api.continueSession(sessionId, mode);
      setState('launched');
      setTimeout(() => setState('idle'), 2500);
    } catch {
      setState('error');
    }
  };

  const commandFor = (mode: Mode) => (mode === 'fork' ? resume.forkCommand : resume.resumeCommand);

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
        {resume.canAutoOpen ? (
          <>
            <p className="tv-continue__hint">Opens in your default terminal.</p>
            <div className="tv-continue__actions">
              <button
                type="button"
                className="tv-linkbtn"
                disabled={state === 'launching'}
                onClick={() => launch('resume')}
              >
                Resume
              </button>
              {resume.forkCommand ? (
                <button
                  type="button"
                  className="tv-linkbtn"
                  disabled={state === 'launching'}
                  onClick={() => launch('fork')}
                  title="Continue in a new session, leaving this transcript untouched"
                >
                  Fork to new session
                </button>
              ) : null}
            </div>
            {state === 'launched' ? (
              <p className="tv-continue__status">Opening in your terminal…</p>
            ) : null}
            {state === 'error' ? (
              <>
                <p className="tv-continue__status tv-continue__status--err">
                  Couldn’t open a terminal. Run it yourself:
                </p>
                <CommandRow command={resume.resumeCommand} />
                {resume.forkCommand ? <CommandRow command={resume.forkCommand} /> : null}
              </>
            ) : null}
          </>
        ) : (
          <>
            <p className="tv-continue__hint">Run this in your terminal:</p>
            <CommandRow command={commandFor('resume') as string} />
            {resume.forkCommand ? (
              <>
                <p className="tv-continue__hint">Or fork into a new session:</p>
                <CommandRow command={resume.forkCommand} />
              </>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}
