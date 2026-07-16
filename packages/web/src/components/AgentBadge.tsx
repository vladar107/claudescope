/** A small chip identifying the agent (connector) that produced a session. */

const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  junie: 'Junie',
  pi: 'pi',
  opencode: 'opencode',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
  grok: 'Grok',
};

/** Human-friendly short label for a connector id. */
export function agentLabel(id: string): string {
  return AGENT_LABELS[id] ?? id;
}

export interface AgentBadgeProps {
  connectorId: string;
}

export function AgentBadge({ connectorId }: AgentBadgeProps) {
  return (
    <span className={`tv-chip tv-chip--agent tv-agent--${connectorId}`} title={`Agent: ${agentLabel(connectorId)}`}>
      {agentLabel(connectorId)}
    </span>
  );
}
