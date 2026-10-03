/**
 * Extensions landing (`/extensions`) — a card grid, one card per locally
 * detected agent (connector): its skills (with usage), MCP servers, hooks, and
 * plugins. Skills keep a preview of the most recently updated one so the screen
 * is never just bare counts. Agents with none of the four are shown explicitly
 * as such rather than hidden (so "no store" reads as a fact, not a bug).
 *
 * Everything is read LIVE from the agent home dirs on the server (never
 * indexed), so this page just fetches and renders. For MCP servers, hooks, and
 * plugins a `null` list means the agent has no such concept (the kind is left
 * off its card) while `[]` means supported but nothing configured. "Nothing
 * installed" is a normal, first-class state, never an error. Invocation counts
 * (skills only) come from the index and are ABSENT — not 0 — for agents whose
 * format records no skill invocation.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type {
  AgentExtensions,
  AgentSkills,
  ExtensionsResponse,
  SkillsConnectorOverview,
  SkillsResponse,
} from '@claudescope/shared';
import { api } from '../../api/client.js';
import { AgentBadge, ErrorBox, Spinner } from '../../components';
import { isBenignError } from '../memory/shared.js';
import './extensions.css';

interface CardData {
  connectorId: string;
  label: string;
  skills?: SkillsConnectorOverview;
  skillsAgent?: AgentSkills;
  ext?: AgentExtensions;
}

/** Skills-response order first, then agents only the extensions response knows. */
function buildCards(skills: SkillsResponse, extensions: ExtensionsResponse): CardData[] {
  const cards: CardData[] = skills.connectors.map((c) => ({
    connectorId: c.connectorId,
    label: c.label,
    skills: c,
    skillsAgent: skills.agents.find((a) => a.connectorId === c.connectorId),
    ext: extensions.agents.find((a) => a.connectorId === c.connectorId),
  }));
  for (const e of extensions.agents) {
    if (!cards.some((c) => c.connectorId === e.connectorId)) {
      cards.push({ connectorId: e.connectorId, label: e.label, ext: e });
    }
  }
  return cards;
}

export function ExtensionsPage() {
  const [cards, setCards] = useState<CardData[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([api.skills(controller.signal), api.extensions(controller.signal)])
      .then(([skills, extensions]) => {
        setCards(buildCards(skills, extensions));
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
      <h1 className="tv-page-title">Extensions</h1>
      <p className="tv-skills__lede tv-muted">
        Everything each agent can load from its home directory — skills, MCP servers, hooks, and plugins —
        read live. Skills also show how often they were invoked.
      </p>

      {loading ? (
        <Spinner size="lg" label="Loading extensions…" />
      ) : error ? (
        <ErrorBox
          error={error}
          title="Failed to load extensions"
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : !cards || cards.length === 0 ? (
        <p className="tv-muted">No extensions found yet.</p>
      ) : (
        <div className="tv-project-grid">
          {cards.map((c) => (
            <AgentExtensionsCard key={c.connectorId} card={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function AgentExtensionsCard({ card }: { card: CardData }) {
  const { connectorId, label, skills: c, skillsAgent, ext } = card;
  const skillsSupported = c?.supported ?? false;
  const mcp = ext?.mcpServers ?? null;
  const hooks = ext?.hooks ?? null;
  const plugins = ext?.plugins ?? null;
  const anySupported = skillsSupported || mcp !== null || hooks !== null || plugins !== null;

  const body = (
    <>
      <div className="tv-skills-card__head">
        <AgentBadge connectorId={connectorId} />
        <span className="tv-project-card__name">{label}</span>
        {skillsSupported && c && !c.usageSignal ? (
          <span
            className="tv-chip tv-skills-card__flag"
            title={skillsAgent?.usageNote ?? "This agent's format records no skill invocation"}
          >
            usage unavailable
          </span>
        ) : null}
      </div>

      {anySupported ? (
        <>
          {skillsSupported && c ? (
            <div className="tv-skills-card__counts tv-muted">
              {plural(c.installed, 'skill')}
              {c.usageSignal && c.installed > 0 ? (
                <>
                  {' '}
                  · {c.used} used · {c.neverUsed} never used
                </>
              ) : null}
              {c.unlocated > 0 ? <> · {c.unlocated} used but not installed globally</> : null}
            </div>
          ) : null}
          {mcp ? (
            <div className="tv-skills-card__counts tv-muted">{plural(mcp.length, 'MCP server')}</div>
          ) : null}
          {hooks ? (
            <div className="tv-skills-card__counts tv-muted">{plural(hooks.length, 'hook')}</div>
          ) : null}
          {plugins ? (
            <div className="tv-skills-card__counts tv-muted">{plural(plugins.length, 'plugin')}</div>
          ) : null}
          {skillsSupported && c && c.installed > 0 && c.preview ? (
            <div className="tv-skills-card__preview">
              <span className="tv-skills-card__preview-label">{c.preview.name}</span>
              {c.preview.description ? (
                <span className="tv-skills-card__preview-body">{c.preview.description}</span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="tv-skills-card__empty tv-muted">
          {label} has no skills, MCP servers, hooks, or plugins in its home directory.
        </div>
      )}
    </>
  );

  // Agents with something to show drill into their inventory; the rest have
  // nothing to open, so they render as a plain (non-clickable) card.
  return anySupported ? (
    <Link
      to={`/extensions/${encodeURIComponent(connectorId)}`}
      className="tv-card tv-project-card tv-skills-card"
    >
      {body}
    </Link>
  ) : (
    <div className="tv-card tv-project-card tv-skills-card tv-skills-card--nostore">{body}</div>
  );
}
