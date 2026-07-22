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
import { getCachedLatest, updateAvailable } from '../update-check.js';

/** Stamped at module load ≈ process start; good enough for an uptime display. */
const startedAt = new Date().toISOString();

export async function registerSystemRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/system', async (): Promise<SystemInfoResponse> => {
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
  });
}
