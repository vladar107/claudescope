/**
 * Fastify server entrypoint. Boots on {@link PORT}, registers API routes, and
 * (in production) serves the built web assets from disk.
 */

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  APP_VERSION,
  CLAUDE_PROJECTS_DIR,
  OPEN_BROWSER,
  PORT,
  REINDEX_INTERVAL_MS,
  WEB_DIST_DIR,
  ensureStateDir,
} from './config.js';
import { registerRoutes } from './routes/index.js';
import { reindex } from './data/index.js';

/** Open a URL in the user's default browser (best-effort, cross-platform). */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    /* non-fatal: the URL is printed in the banner regardless */
  }
}

async function main(): Promise<void> {
  // Create ~/.claudescope and seed the user-editable pricing file before any
  // module touches the index or pricing.
  ensureStateDir();

  const app = Fastify({ logger: true });

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
        .catch((err) => app.log.error({ err }, 'auto-reindex failed'));
    }, REINDEX_INTERVAL_MS);
    timer.unref(); // don't keep the process alive solely for the timer
    app.addHook('onClose', async () => clearInterval(timer));
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
