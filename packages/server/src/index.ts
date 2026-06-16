/**
 * Fastify server entrypoint. Boots on {@link PORT}, registers API routes, and
 * (in production) serves the built web assets from disk.
 */

import { existsSync, readFileSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import type { FetchedPricing } from '@claudescope/shared';
import {
  APP_VERSION,
  CLAUDE_PROJECTS_DIR,
  FETCHED_PRICING_PATH,
  OPEN_BROWSER,
  PORT,
  PRICING_REFRESH_INTERVAL_MS,
  REINDEX_INTERVAL_MS,
  WEB_DIST_DIR,
  ensureStateDir,
} from './config.js';
import { registerRoutes } from './routes/index.js';
import { registerSecurityHeaders } from './security.js';
import { reindex } from './data/index.js';
import { refreshPricing } from './data/pricing-refresh.js';
import { openBrowser } from './util/open-browser.js';

/** How old a fetched-pricing snapshot may be before a boot refresh fires. */
const PRICING_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the fetched-pricing snapshot is missing, unparsable, or older than
 * {@link PRICING_STALE_MS} — i.e. worth refreshing on boot.
 */
function pricingSnapshotIsStale(): boolean {
  try {
    const snapshot = JSON.parse(readFileSync(FETCHED_PRICING_PATH, 'utf8')) as FetchedPricing;
    const fetchedAt = Date.parse(snapshot?.fetchedAt ?? '');
    if (!Number.isFinite(fetchedAt)) return true;
    return Date.now() - fetchedAt > PRICING_STALE_MS;
  } catch {
    return true; // missing or corrupt → refresh
  }
}

async function main(): Promise<void> {
  // Create ~/.claudescope and seed the user-editable pricing file before any
  // module touches the index or pricing.
  ensureStateDir();

  const app = Fastify({ logger: true });

  // Lock down what the served SPA may load — notably block remote image fetches
  // from transcript content (see security.ts).
  registerSecurityHeaders(app);

  await registerRoutes(app);

  // Kick off an initial (incremental) index build in the background so the
  // server can accept connections immediately. /api/health reports readiness.
  reindex()
    .then((res) =>
      app.log.info(
        { reindexed: res.reindexed, durationMs: res.durationMs },
        'initial index build complete',
      ),
    )
    .catch((err) => app.log.error({ err }, 'initial index build failed'));

  // Auto-reindex on an interval so live/new sessions appear without a restart.
  // Each poll stats files and returns immediately when nothing changed, so it's
  // cheap; only log when work was actually done.
  if (REINDEX_INTERVAL_MS > 0) {
    const timer = setInterval(() => {
      reindex()
        .then((res) => {
          if (res.reindexed > 0) {
            app.log.info(
              { reindexed: res.reindexed, durationMs: res.durationMs },
              'auto-reindex picked up changes',
            );
          }
        })
        // A background poll failing is non-fatal — the server keeps serving the
        // existing index — so warn rather than error (avoids error-level spam
        // every interval when, e.g., a single file is briefly unreadable).
        .catch((err) => app.log.warn({ err }, 'auto-reindex failed'));
    }, REINDEX_INTERVAL_MS);
    timer.unref(); // don't keep the process alive solely for the timer
    app.addHook('onClose', async () => clearInterval(timer));
  }

  // Auto-refresh pricing from LiteLLM: once at boot when the snapshot is
  // missing/stale (>24h), then on an interval so long-running daemons track new
  // models and rate changes. Set PRICING_REFRESH_INTERVAL_MS=0 to disable both
  // (no network calls). No explicit cache-bust is needed: loadPricing's mtime
  // cache picks up the rewritten file on the next reindex poll. Never blocks
  // startup; failures are non-fatal — the loader falls back to last-known /
  // shipped rates.
  if (PRICING_REFRESH_INTERVAL_MS > 0) {
    const runPricingRefresh = (): void => {
      refreshPricing()
        .then((res) =>
          app.log.info(
            { modelCount: res.modelCount, changed: res.changed },
            'pricing refresh complete',
          ),
        )
        .catch((err) => app.log.warn({ err }, 'pricing refresh failed — keeping last-known rates'));
    };

    if (pricingSnapshotIsStale()) runPricingRefresh();
    const pricingTimer = setInterval(runPricingRefresh, PRICING_REFRESH_INTERVAL_MS);
    pricingTimer.unref();
    app.addHook('onClose', async () => clearInterval(pricingTimer));
  }

  // In production, serve the built SPA. In dev, Vite serves it and proxies /api.
  if (existsSync(WEB_DIST_DIR)) {
    await app.register(fastifyStatic, { root: WEB_DIST_DIR });
    // SPA fallback for client-side routing.
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api')) {
        reply.code(404).send({ error: 'Not Found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  const servesWeb = existsSync(WEB_DIST_DIR);
  if (!existsSync(CLAUDE_PROJECTS_DIR)) {
    app.log.warn(
      `sessions directory not found: ${CLAUDE_PROJECTS_DIR} — the app will be empty. ` +
        'Set CLAUDE_PROJECTS_DIR to point at your Claude Code transcripts.',
    );
  }
  await app.listen({ port: PORT, host: '127.0.0.1' });

  const url = `http://localhost:${PORT}`;
  // A human-friendly banner so the app reads like a real local tool, not a
  // bare server log. Shows the resolved (configurable) sessions directory.
  app.log.info(
    '\n' +
      `  Claudescope v${APP_VERSION}\n` +
      `  ▸ URL:      ${url}\n` +
      `  ▸ Sessions: ${CLAUDE_PROJECTS_DIR} (read-only)\n` +
      (servesWeb ? '' : '  ▸ Note:     web build not found — run `npm run build` to serve the UI\n'),
  );

  if (OPEN_BROWSER && servesWeb) openBrowser(url);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
