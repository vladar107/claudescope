/**
 * GET /api/sources — the read-only source directories backing each connector.
 *
 * Used by the sidebar footer to show what's being read. Only connectors whose
 * source directory exists on disk are returned, with the home dir contracted
 * to `~` for display.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { SourcesResponse } from '@claudescope/shared';
import { connectors } from '../connectors/registry.js';

/** Contract a leading home-dir path to `~` for display. */
function tildify(p: string): string {
  const home = homedir();
  return p === home ? '~' : p.startsWith(home + '/') ? `~${p.slice(home.length)}` : p;
}

export async function registerSourcesRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/sources', async (): Promise<SourcesResponse> => {
    return connectors
      .filter((c) => existsSync(c.sourceDir))
      .map((c) => ({ id: c.id, label: c.label, path: tildify(c.sourceDir) }));
  });
}
