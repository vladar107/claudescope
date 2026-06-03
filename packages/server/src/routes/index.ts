/**
 * API route registration. Wires the health check plus every feature route per
 * the API contract: projects, sessions (list + detail), search, analytics, and
 * reindex.
 */

import type { FastifyInstance } from 'fastify';
import type { HealthResponse, ReindexResponse } from '@claudescope/shared';
import { APP_VERSION } from '../config.js';
import { isIndexReady, reindex } from '../data/index.js';
import { registerProjectsRoute } from './projects.js';
import { registerSessionsRoutes } from './sessions.js';
import { registerSearchRoute } from './search.js';
import { registerAnalyticsRoute } from './analytics.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (): Promise<HealthResponse & { ready: boolean }> => {
    return { status: 'ok', version: APP_VERSION, ready: isIndexReady() };
  });

  await registerProjectsRoute(app);
  await registerSessionsRoutes(app);
  await registerSearchRoute(app);
  await registerAnalyticsRoute(app);

  app.post('/api/reindex', async (): Promise<ReindexResponse> => {
    return reindex();
  });
}
