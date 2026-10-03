/**
 * Extensions route — the MCP servers, hooks, and plugins configured for each
 * agent, read live (NOT indexed) from the agent home dirs.
 *
 *   - GET /api/extensions → one entry per detected agent with its MCP servers,
 *                           hooks, and plugins. A `null` list means the agent
 *                           has no such concept (not supported); `[]` means
 *                           nothing is configured.
 *
 * Collection, redaction-safe shaping and ordering live in `data/extensions.ts`.
 * An empty config is a normal state, not an error.
 */

import type { FastifyInstance } from 'fastify';
import type { ExtensionsResponse } from '@claudescope/shared';
import { collectExtensions } from '../data/extensions.js';

export async function registerExtensionsRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/extensions', async (): Promise<ExtensionsResponse> => collectExtensions());
}
