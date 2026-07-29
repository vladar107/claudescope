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
  FETCHED_PRICING_PATH,
  OPEN_BROWSER,
  PORT,
  PRICING_REFRESH_INTERVAL_MS,
  SELF_RESTART_INTERVAL_MS,
  WEB_DIST_DIR,
  initStateDir,
} from './config.js';
import { claudeProjectsDir } from './settings.js';
import { registerRoutes } from './routes/index.js';
import { registerHostGuard, registerMutationGuard, registerSecurityHeaders } from './security.js';
import { startIndexer, stopIndexerTimer } from './indexer-lifecycle.js';
import { refreshPricing } from './data/pricing-refresh.js';
import { maybeSelfRestart } from './self-restart.js';
import { refreshLatestVersion } from './update-check.js';
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
  initStateDir();

  const app = Fastify({ logger: true });

  // Reject non-loopback Host headers (anti DNS-rebinding) before anything routes,
  // block cross-origin mutations (CSRF), and lock down what the served SPA may
  // load (CSP). See security.ts.
  registerHostGuard(app);
  registerMutationGuard(app);
  registerSecurityHeaders(app);

  await registerRoutes(app);

  // Kick the initial background build and arm the auto-reindex poller. The
  // indexer-lifecycle module owns both so the Settings page can pause/resume/
  // restart indexing and re-arm the interval at runtime.
  startIndexer(app.log);
  app.addHook('onClose', async () => stopIndexerTimer());

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

  // Update-availability check: refresh the daemon-side "latest published
  // version" cache so /api/health can carry `updateAvailable` for the web UI's
  // sidebar nudge. Cheap — getLatestVersion caches on disk for 24h, so the
  // hourly tick mostly re-reads the file and the network is hit ≤ once a day.
  // Dev builds skip it (nothing meaningful to compare against).
  if (APP_VERSION !== '0.0.0-dev') {
    void refreshLatestVersion();
    const updateTimer = setInterval(() => void refreshLatestVersion(), 60 * 60 * 1000);
    updateTimer.unref();
    app.addHook('onClose', async () => clearInterval(updateTimer));
  }

  // Post-update self-heal: periodically check whether the installed
  // `claudescope` on PATH is a newer/different version than this process and,
  // if so, hand off to `claudescope restart` so brew/nix/out-of-band npm
  // upgrades take effect without a manual restart. Dev builds never restart.
  if (SELF_RESTART_INTERVAL_MS > 0 && APP_VERSION !== '0.0.0-dev') {
    const selfRestartTimer = setInterval(() => {
      maybeSelfRestart((m) => app.log.info(m)).catch((err) =>
        app.log.warn({ err }, 'self-restart check failed'),
      );
    }, SELF_RESTART_INTERVAL_MS);
    selfRestartTimer.unref();
    app.addHook('onClose', async () => clearInterval(selfRestartTimer));
  }

  // In production, serve the built SPA. In dev, Vite serves it and proxies /api.
  const servesWeb = existsSync(WEB_DIST_DIR);
  if (servesWeb) {
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

  if (!existsSync(claudeProjectsDir())) {
    app.log.warn(
      `sessions directory not found: ${claudeProjectsDir()} — the app will be empty. ` +
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
      `  ▸ Sessions: ${claudeProjectsDir()} (read-only)\n` +
      (servesWeb ? '' : '  ▸ Note:     web build not found — run `npm run build` to serve the UI\n'),
  );

  if (OPEN_BROWSER && servesWeb) openBrowser(url);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
