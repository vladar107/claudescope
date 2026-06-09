/**
 * The set of enabled agent connectors. Adding support for another agent (Codex,
 * …) means implementing an {@link AgentConnector} and registering it here.
 */

import type { AgentConnector } from './types.js';
import { claudeCodeConnector } from './claude-code.js';

export const connectors: AgentConnector[] = [claudeCodeConnector];

/**
 * The connector that owns a given session. With a single connector this always
 * resolves to Claude Code; once a second source exists this will dispatch on a
 * `connector_id` recorded per file at index time.
 */
export function connectorForSession(_sessionId: string): AgentConnector {
  return claudeCodeConnector;
}
