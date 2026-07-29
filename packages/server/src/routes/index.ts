/**
 * API route registration. Wires the health check plus every feature route per
 * the API contract: projects, sessions (list + detail), search, analytics,
 * sources, memory, and reindex.
 */

import type { FastifyInstance } from 'fastify';
import type { HealthResponse, ReindexResponse } from '@claudescope/shared';
import { APP_VERSION } from '../config.js';
import { getDataVersion, getIndexProgress, isIndexReady, reindex } from '../data/index.js';
import { BadRequestError } from '../params.js';
import { getIndexerStatus } from '../indexer-lifecycle.js';
import { updateAvailable } from '../update-check.js';
import { registerProjectsRoute } from './projects.js';
import { registerSessionsRoutes } from './sessions.js';
import { registerSearchRoute } from './search.js';
import { registerAnalyticsRoute } from './analytics.js';
import { registerSessionEfficiencyRoute } from './analytics-sessions.js';
import { registerAgentComparisonRoute } from './analytics-agents.js';
import { registerActivityRoute } from './analytics-activity.js';
import { registerToolsRoute } from './analytics-tools.js';
import { registerImpactRoute } from './analytics-impact.js';
import { registerErrorsRoute } from './analytics-errors.js';
import { registerDigestRoute } from './analytics-digest.js';
import { registerSourcesRoute } from './sources.js';
import { registerMemoryRoute } from './memory.js';
import { registerSettingsRoute } from './settings.js';
import { registerIndexerRoutes } from './indexer.js';
import { registerPricingRoute } from './pricing.js';
import { registerSystemRoute } from './system.js';

/**
 * Single error handler for the API.
 *
 * Two jobs. It maps {@link BadRequestError} — thrown by the param validators in
 * `params.ts` — to a 400 carrying the reason, so a bad query param is a client
 * error rather than a crash. And it stops leaking implementation detail: every
 * query in this app is string-built, so Fastify's default handler was
 * serializing DuckDB parser/conversion errors verbatim, shipping the generated
 * statement (table and column names included) to the client. The full error
 * still goes to the server log, so debuggability is unchanged.
 *
 * Registered here rather than in `index.ts`'s `main()` so the test harness —
 * which builds a bare Fastify around `registerRoutes` — exercises the same
 * behaviour as production.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof BadRequestError) {
      void reply.code(400).send({ error: err.message });
      return;
    }
    // Preserve deliberate client errors (Fastify's own 4xx: unsupported media
    // type, malformed JSON body, …) — those messages are about the request, not
    // about our internals.
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 400 && status < 500) {
      void reply.code(status).send({ error: (err as Error).message });
      return;
    }
    req.log.error({ err }, 'unhandled error serving request');
    void reply.code(500).send({ error: 'Internal Server Error' });
  });
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  registerErrorHandler(app);

  app.get('/api/health', async (): Promise<HealthResponse> => {
    const indexing = getIndexProgress();
    const latest = updateAvailable();
    const { state, paused, intervalMs } = getIndexerStatus();
    return {
      status: 'ok',
      version: APP_VERSION,
      ready: isIndexReady(),
      dataVersion: getDataVersion(),
      ...(indexing ? { indexing } : {}),
      ...(latest ? { updateAvailable: latest } : {}),
      indexer: { state, paused, intervalMs },
    };
  });

  await registerProjectsRoute(app);
  await registerSessionsRoutes(app);
  await registerSearchRoute(app);
  await registerAnalyticsRoute(app);
  await registerSessionEfficiencyRoute(app);
  await registerAgentComparisonRoute(app);
  await registerActivityRoute(app);
  await registerToolsRoute(app);
  await registerImpactRoute(app);
  await registerErrorsRoute(app);
  await registerDigestRoute(app);
  await registerSourcesRoute(app);
  await registerMemoryRoute(app);
  await registerSettingsRoute(app);
  await registerIndexerRoutes(app);
  await registerPricingRoute(app);
  await registerSystemRoute(app);

  app.post('/api/reindex', async (): Promise<ReindexResponse> => {
    return reindex();
  });
}
