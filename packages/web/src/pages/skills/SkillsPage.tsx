/**
 * Skills landing (`/skills`) — a card grid, one card per locally detected agent
 * (connector), previewing the most recently updated skill so the screen is never
 * just bare counts. Agents that keep no skills store are shown explicitly as
 * such rather than hidden (so "no store" reads as a fact, not a bug).
 *
 * Skills are read LIVE from the agent home dirs on the server (never indexed),
 * so this page just fetches and renders. "No skills" is a normal, first-class
 * state here, never an error. Invocation counts come from the index and are
 * ABSENT — not 0 — for agents whose format records no skill invocation.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AgentSkills, SkillsConnectorOverview, SkillsResponse } from '@claudescope/shared';
import { api } from '../../api/client.js';
import { AgentBadge, ErrorBox, Spinner } from '../../components';
import { isBenignError } from '../memory/shared.js';
import './skills.css';

export function SkillsPage() {
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .skills(controller.signal)
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
    <div className="tv-skills">
      <h1 className="tv-page-title">Skills</h1>
      <p className="tv-skills__lede tv-muted">
        Every skill each agent can load, read live from its home directory, with
        how often it was actually invoked. Pick an agent to see where each skill
        lives and which agents share it.
      </p>

      {loading ? (
        <Spinner size="lg" label="Loading skills…" />
      ) : error ? (
        <ErrorBox error={error} title="Failed to load skills" onRetry={() => setReloadKey((k) => k + 1)} />
      ) : !data || data.connectors.length === 0 ? (
        <p className="tv-muted">No skills found yet.</p>
      ) : (
        <div className="tv-project-grid">
          {data.connectors.map((c) => (
            <AgentSkillsCard
              key={c.connectorId}
              c={c}
              agent={data.agents.find((a) => a.connectorId === c.connectorId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentSkillsCard({ c, agent }: { c: SkillsConnectorOverview; agent?: AgentSkills }) {
  const body = (
    <>
      <div className="tv-skills-card__head">
        <AgentBadge connectorId={c.connectorId} />
        <span className="tv-project-card__name">{c.label}</span>
        {!c.supported ? (
          <span className="tv-chip tv-skills-card__flag" title="This agent loads no skills from its home directory">
            no skills store
          </span>
        ) : !c.usageSignal ? (
          <span
            className="tv-chip tv-skills-card__flag"
            title={agent?.usageNote ?? "This agent's format records no skill invocation"}
          >
            usage unavailable
          </span>
        ) : null}
      </div>

      {c.supported ? (
        <>
          <div className="tv-skills-card__counts tv-muted">
            {c.installed} skill{c.installed === 1 ? '' : 's'}
            {c.usageSignal && c.installed > 0 ? (
              <>
                {' '}
                · {c.used} used · {c.neverUsed} never used
              </>
            ) : null}
            {c.unlocated > 0 ? <> · {c.unlocated} used but not installed globally</> : null}
          </div>
          {c.installed > 0 && c.preview ? (
            <div className="tv-skills-card__preview">
              <span className="tv-skills-card__preview-label">{c.preview.name}</span>
              {c.preview.description ? (
                <span className="tv-skills-card__preview-body">{c.preview.description}</span>
              ) : null}
            </div>
          ) : (
            <div className="tv-skills-card__empty tv-muted">
              No skills installed in this agent&rsquo;s home directory.
            </div>
          )}
        </>
      ) : (
        <div className="tv-skills-card__empty tv-muted">
          {c.label} loads no skills from its home directory. Its sessions still render in full.
        </div>
      )}
    </>
  );

  // Supported agents drill into their skill inventory; unsupported ones have
  // nothing to open, so they render as a plain (non-clickable) card.
  return c.supported ? (
    <Link
      to={`/skills/${encodeURIComponent(c.connectorId)}`}
      className="tv-card tv-project-card tv-skills-card"
    >
      {body}
    </Link>
  ) : (
    <div className="tv-card tv-project-card tv-skills-card tv-skills-card--nostore">{body}</div>
  );
}
