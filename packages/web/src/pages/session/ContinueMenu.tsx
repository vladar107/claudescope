import { useEffect, useRef, useState } from 'react';
import { Copy, GitBranch, Play, RotateCcw } from 'lucide-react';
import type { ResumeInfo } from '@claudescope/shared';
import { AgentBadge } from '../../components';

/** A copy-paste command line with its own Copy button. The command wraps in full. */
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
      <button type="button" className="tv-btn tv-btn--secondary tv-btn--sm" onClick={copy}>
        {copied ? (
          'Copied!'
        ) : (
          <>
            <Copy size={13} aria-hidden="true" /> Copy
          </>
        )}
      </button>
    </div>
  );
}

/**
 * "Continue" dropdown: the command to reopen this session in the agent's own CLI,
 * for the user to copy and run in their terminal. Resume (append) is offered for
 * every agent; Fork (a fresh, untouched copy) only when the CLI supports it.
 * Claudescope only ever copies a string — it never executes anything.
 */
export function ContinueMenu({
  resume,
  connectorId,
  projectName,
  branch,
}: {
  resume: ResumeInfo;
  connectorId: string;
  projectName?: string;
  branch?: string;
}) {
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
        <Play size={14} aria-hidden="true" /> Continue
      </summary>
      <div className="tv-continue__menu">
        <div className="tv-continue__head">
          <Play size={16} aria-hidden="true" />
          <strong>Continue this session</strong>
        </div>
        <p className="tv-continue__lead">
          Pick this run back up in your terminal. Claudescope only copies a command — it never runs
          anything.
        </p>
        <div className="tv-continue__ctx">
          <AgentBadge connectorId={connectorId} />
          {projectName ? <span className="tv-chip">{projectName}</span> : null}
          {branch ? <span className="tv-chip tv-mono">{branch}</span> : null}
        </div>

        <div className="tv-continue__opt">
          <div className="tv-continue__opt-head">
            <RotateCcw size={15} aria-hidden="true" />
            <strong>Resume in place</strong>
          </div>
          <p className="tv-continue__opt-desc">
            Continues the same session — same history and id. New turns append to this transcript.
          </p>
          <CommandRow command={resume.resumeCommand} />
        </div>

        {resume.forkCommand ? (
          <div className="tv-continue__opt">
            <div className="tv-continue__opt-head">
              <GitBranch size={15} aria-hidden="true" />
              <strong>Fork to a new session</strong>
            </div>
            <p className="tv-continue__opt-desc">
              Branches a copy and leaves this transcript untouched — for trying a different direction
              safely.
            </p>
            <CommandRow command={resume.forkCommand} />
          </div>
        ) : null}
      </div>
    </details>
  );
}
