/**
 * Indexer lifecycle actions. These control the background indexing engine —
 * the reindex poller + DuckDB ingest — never the HTTP process (which is
 * stopped from the terminal only). All responses carry the fresh
 * {@link IndexerStatus} so the UI updates without a second round-trip.
 */

import type { FastifyInstance } from 'fastify';
import type { IndexerStatus, RebuildStartedResponse } from '@claudescope/shared';
import { isRebuildInFlight, rebuildIndex } from '../data/index.js';
import { pauseIndexing, restartIndexing, resumeIndexing } from '../indexer-lifecycle.js';

export async function registerIndexerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/indexer/stop', async (): Promise<IndexerStatus> => pauseIndexing());

  app.post('/api/indexer/start', async (): Promise<IndexerStatus> => resumeIndexing());

  app.post('/api/indexer/restart', async (): Promise<IndexerStatus> => restartIndexing());

  // Danger zone: discard the DuckDB file and rebuild from the sources. 202 —
  // the rebuild runs in the background and progress rides the existing
  // /api/health building UX (ready=false + indexing progress).
  app.post('/api/index/rebuild', async (_req, reply): Promise<RebuildStartedResponse | undefined> => {
    if (isRebuildInFlight()) {
      void reply.code(409).send({ error: 'a rebuild is already in progress' });
      return;
    }
    rebuildIndex().catch((err) => app.log.error({ err }, 'index rebuild failed'));
    void reply.code(202);
    return { started: true };
  });
}
