/**
 * Per-process system info for the Settings page's Status and Update cards:
 * version vs latest, the install-method-specific upgrade command (shown,
 * never executed server-side), process start time for uptime.
 */

import type { FastifyInstance } from 'fastify';
import type { SystemInfoResponse } from '@claudescope/shared';
import { APP_VERSION } from '../config.js';
import { getDataVersion } from '../data/index.js';
import { detectInstallMethod, updateCommandFor } from '../install-method.js';
import { getCachedLatest, refreshLatestVersion, updateAvailable } from '../update-check.js';

/** Stamped at module load ≈ process start; good enough for an uptime display. */
const startedAt = new Date().toISOString();

/** Snapshot the current process/update state for both the read and refresh routes. */
function systemInfo(): SystemInfoResponse {
  const installMethod = detectInstallMethod();
  return {
    version: APP_VERSION,
    latestVersion: getCachedLatest(),
    updateAvailable: updateAvailable() !== null,
    installMethod,
    updateCommand: updateCommandFor(installMethod),
    startedAt,
    dataVersion: getDataVersion(),
  };
}

export async function registerSystemRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/system', async (): Promise<SystemInfoResponse> => systemInfo());

  app.post(
    '/api/system/update-check',
    async (_req, reply): Promise<SystemInfoResponse | undefined> => {
      if (!(await refreshLatestVersion(true))) {
        app.log.warn('on-demand update check failed');
        void reply
          .code(502)
          .send({ error: 'update check failed — could not reach the npm registry' });
        return;
      }
      return systemInfo();
    },
  );
}
