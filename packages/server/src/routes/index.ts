/**
 * API route registration. Wires the health check plus every feature route per
 * the API contract: projects, sessions (list + detail), search, analytics,
 * sources, memory, and reindex.
 */

import type { FastifyInstance } from 'fastify';
import type { HealthResponse, ReindexResponse } from '@claudescope/shared';
import { APP_VERSION } from '../config.js';
import { isIndexReady, reindex } from '../data/index.js';
import { registerProjectsRoute } from './projects.js';
import { registerSessionsRoutes } from './sessions.js';
import { registerSearchRoute } from './search.js';
import { registerAnalyticsRoute } from './analytics.js';
import { registerSessionEfficiencyRoute } from './analytics-sessions.js';
import { registerActivityRoute } from './analytics-activity.js';
import { registerToolsRoute } from './analytics-tools.js';
import { registerSourcesRoute } from './sources.js';
import { registerMemoryRoute } from './memory.js';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (): Promise<HealthResponse & { ready: boolean }> => {
    return { status: 'ok', version: APP_VERSION, ready: isIndexReady() };
  });

  await registerProjectsRoute(app);
  await registerSessionsRoutes(app);
  await registerSearchRoute(app);
  await registerAnalyticsRoute(app);
  await registerSessionEfficiencyRoute(app);
  await registerActivityRoute(app);
  await registerToolsRoute(app);
  await registerSourcesRoute(app);
  await registerMemoryRoute(app);

  app.post('/api/reindex', async (): Promise<ReindexResponse> => {
    return reindex();
  });
}
