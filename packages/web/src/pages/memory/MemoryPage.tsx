/**
 * Memory landing (`/memory`) — a folder grid, one card per locally detected
 * agent (connector).
 * Each card previews real content (the latest memory item) so the screen is
 * never just bare counts; agents that keep no memory store are shown explicitly
 * as such rather than hidden (so "no store" reads as a fact, not a bug).
 *
 * Memory is read LIVE from the agent home dirs on the server (never indexed), so
 * this page just fetches and renders. Every store is usually absent/empty —
 * "no memory" is a normal, first-class state here, never an error.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { MemoryConnectorOverview, MemoryPreview, MemoryResponse } from '@claudescope/shared';
import { api } from '../../api/client.js';
import { AgentBadge, ErrorBox, Spinner } from '../../components';
import { isBenignError } from './shared.js';
import './memory.css';

/** Short label above the preview body. */
function previewLabel(p: MemoryPreview): string {
  if (p.kind === 'fact') return `Latest fact${p.category ? ` · ${p.category}` : ''}`;
  return p.title; // a document (instruction file) — its name is the label
}

/** The preview body line: fact name + description, or a document excerpt. */
function previewBody(p: MemoryPreview): string {
  if (p.kind === 'fact') return p.description ? `${p.title} — ${p.description}` : p.title;
  return p.description || p.title;
}

export function MemoryPage() {
  const [data, setData] = useState<MemoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .memory(controller.signal)
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (isBenignError(err)) return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  return (
    <div className="tv-memory">
      <h1 className="tv-page-title">Memory</h1>
      <p className="tv-memory__lede tv-muted">
        Long-lived instruction files and agent-distilled memory, read live from
        each agent&rsquo;s home directory. Pick an agent to browse its global
        memory and per-project facts.
      </p>

      {loading ? (
        <Spinner size="lg" label="Loading memory…" />
      ) : error ? (
        <ErrorBox error={error} title="Failed to load memory" onRetry={() => setReloadKey((k) => k + 1)} />
      ) : !data || data.connectors.length === 0 ? (
        <p className="tv-muted">No memory found yet.</p>
      ) : (
        <div className="tv-project-grid">
          {data.connectors.map((c) => (
            <AgentMemoryCard key={c.connectorId} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentMemoryCard({ c }: { c: MemoryConnectorOverview }) {
  const body = (
    <>
      <div className="tv-memory-card__head">
        <AgentBadge connectorId={c.connectorId} />
        <span className="tv-project-card__name">{c.label}</span>
        {!c.supported ? (
          <span className="tv-chip tv-memory-card__nostore" title="This agent keeps no memory store">
            no memory store
          </span>
        ) : null}
      </div>

      {c.supported ? (
        <>
          <div className="tv-memory-card__counts tv-muted">
            {c.globalFiles} instruction file{c.globalFiles === 1 ? '' : 's'} · {c.projectsWithFacts}{' '}
            project{c.projectsWithFacts === 1 ? '' : 's'} · {c.totalFacts} fact
            {c.totalFacts === 1 ? '' : 's'}
          </div>
          {c.preview ? (
            <div className="tv-memory-card__preview">
              <span className="tv-memory-card__preview-label">{previewLabel(c.preview)}</span>
              <span className="tv-memory-card__preview-body">{previewBody(c.preview)}</span>
            </div>
          ) : (
            <div className="tv-memory-card__empty tv-muted">
              No distilled facts yet — they appear as the agent works in a project.
            </div>
          )}
        </>
      ) : (
        <div className="tv-memory-card__empty tv-muted">
          {c.label} keeps no memory in its home directory. Its reasoning and edits still render
          inside sessions.
        </div>
      )}
    </>
  );

  // Supported agents drill into their memory; unsupported ones have nothing to
  // open, so they render as a plain (non-clickable) card.
  return c.supported ? (
    <Link
      to={`/memory/${encodeURIComponent(c.connectorId)}`}
      className="tv-card tv-project-card tv-memory-card"
    >
      {body}
    </Link>
  ) : (
    <div className="tv-card tv-project-card tv-memory-card tv-memory-card--nostore">{body}</div>
  );
}
