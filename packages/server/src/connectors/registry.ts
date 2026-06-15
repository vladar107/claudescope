/**
 * The set of enabled agent connectors. Adding support for another agent means
 * implementing an {@link AgentConnector} and registering it here.
 */

import type { AgentConnector } from './types.js';
import { claudeCodeConnector } from './claude-code/claude-code.js';
import { codexConnector } from './codex/codex.js';
import { junieConnector } from './junie/junie.js';
import { piConnector } from './pi/pi.js';

export const connectors: AgentConnector[] = [
  claudeCodeConnector,
  codexConnector,
  junieConnector,
  piConnector,
];

/** The connector with the given id, falling back to Claude Code if unknown. */
export function connectorById(id: string | null | undefined): AgentConnector {
  return connectors.find((c) => c.id === id) ?? claudeCodeConnector;
}
