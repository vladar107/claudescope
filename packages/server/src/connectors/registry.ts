/**
 * The set of enabled agent connectors. Adding support for another agent means
 * implementing an {@link AgentConnector} and registering it here.
 */

import type { AgentConnector } from './types.js';
import { claudeCodeConnector } from './claude-code.js';
import { codexConnector } from './codex/codex.js';

export const connectors: AgentConnector[] = [claudeCodeConnector, codexConnector];

/** The connector with the given id, falling back to Claude Code if unknown. */
export function connectorById(id: string | null | undefined): AgentConnector {
  return connectors.find((c) => c.id === id) ?? claudeCodeConnector;
}
