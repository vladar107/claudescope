/**
 * The set of enabled agent connectors. Adding support for another agent means
 * implementing an {@link AgentConnector} and registering it here.
 */

import { existsSync } from 'node:fs';
import type { AgentConnector } from './types.js';
import { claudeCodeConnector } from './claude-code/claude-code.js';
import { codexConnector } from './codex/codex.js';
import { junieConnector } from './junie/junie.js';
import { piConnector } from './pi/pi.js';
import { opencodeConnector } from './opencode/opencode.js';
import { copilotConnector } from './copilot/copilot.js';
import { antigravityConnector } from './antigravity/antigravity.js';
import { grokConnector } from './grok/grok.js';

export const connectors: AgentConnector[] = [
  claudeCodeConnector,
  codexConnector,
  junieConnector,
  piConnector,
  opencodeConnector,
  copilotConnector,
  antigravityConnector,
  grokConnector,
];

/**
 * Connectors whose configured read-only transcript source exists locally, plus
 * any connector IDs for which a caller has another concrete local signal (for
 * example, a global memory file before the first transcript directory exists).
 */
export function detectedConnectors(additionalIds: Iterable<string> = []): AgentConnector[] {
  const detectedIds = new Set(additionalIds);
  return connectors.filter(
    (connector) => detectedIds.has(connector.id) || existsSync(connector.sourceDir),
  );
}

/** The connector with the given id, falling back to Claude Code if unknown. */
export function connectorById(id: string | null | undefined): AgentConnector {
  return connectors.find((c) => c.id === id) ?? claudeCodeConnector;
}
