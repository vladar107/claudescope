/**
 * GET /api/sources — the read-only source directories backing each connector.
 *
 * Used by the sidebar footer to show what's being read. Only connectors whose
 * source directory exists on disk are returned, with the home dir contracted
 * to `~` for display.
 */

import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { SourcesResponse } from '@claudescope/shared';
import { connectors } from '../connectors/registry.js';
import { contractHome } from '../util/paths.js';

export async function registerSourcesRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/sources', async (): Promise<SourcesResponse> => {
    return connectors
      .filter((c) => existsSync(c.sourceDir))
      .map((c) => ({ id: c.id, label: c.label, path: contractHome(c.sourceDir) }));
  });
}
