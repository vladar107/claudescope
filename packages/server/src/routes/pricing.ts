/**
 * On-demand pricing refresh — the Settings page's "Sync prices now" button.
 * Same code path as the daily timer and `claudescope pricing update`. New
 * rates apply prospectively (next reindex); rebuilding the index re-prices
 * history.
 */

import type { FastifyInstance } from 'fastify';
import type { PricingRefreshResponse } from '@claudescope/shared';
import { refreshPricing } from '../data/pricing-refresh.js';
import { contractHome } from '../util/paths.js';

export async function registerPricingRoute(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/pricing/refresh',
    async (_req, reply): Promise<PricingRefreshResponse | undefined> => {
      try {
        const res = await refreshPricing();
        return { ...res, path: contractHome(res.path) };
      } catch (err) {
        app.log.warn({ err }, 'on-demand pricing refresh failed');
        void reply
          .code(502)
          .send({ error: 'pricing refresh failed — check network access to LiteLLM' });
        return;
      }
    },
  );
}
