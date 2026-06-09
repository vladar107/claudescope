#!/usr/bin/env node
/**
 * Capture the README screenshots — every canonical view in both light and dark
 * themes — fully automated and reproducible.
 *
 *   npm run screenshots
 *
 * Pipeline: seed synthetic Claude + Codex demo data into a temp area, boot the
 * built server against it (isolated CLAUDESCOPE_HOME / index, so the real index
 * is never touched), then drive Chromium via Playwright to shoot each view at a
 * fixed retina viewport. Output: docs/screenshots/{view}-{light,dark}.png.
 *
 * Requires a production build first (`npm run build`) and the Playwright
 * Chromium browser (`npx playwright install chromium`).
 */

import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SCREENSHOT_PORT ?? 4399);
const BASE = `http://127.0.0.1:${PORT}`;
const outDir = join(root, 'docs', 'screenshots');

const work = mkdtempSync(join(tmpdir(), 'claudescope-shots-'));
const claudeDir = join(work, 'projects');
const codexDir = join(work, 'codex');
const home = join(work, 'home');

const THEMES = /** @type {const} */ (['light', 'dark']);
/** Each view: a path to visit plus a selector that signals it has rendered. */
const VIEWS = [
  { name: 'browse', path: '/', ready: '.tv-project-grid' },
  { name: 'session', path: '/sessions/sess-darkmode', ready: '.tv-session__header' },
  { name: 'search', path: '/search?q=theme', ready: '.tv-search__snippet' },
  { name: 'analytics', path: '/analytics', ready: '.recharts-surface' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`server did not become healthy on ${BASE}`);
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  // 1. Seed synthetic Claude + Codex data.
  console.log('· seeding demo data');
  const seed = spawnSync('node', [join(root, 'scripts', 'demo-seed.mjs'), claudeDir, codexDir], {
    stdio: 'inherit',
  });
  if (seed.status !== 0) throw new Error('demo-seed failed');

  // 2. Boot the built server against the demo data, fully isolated.
  console.log('· starting server');
  const server = spawn('node', [join(root, 'packages', 'server', 'dist', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CLAUDE_PROJECTS_DIR: claudeDir,
      CODEX_SESSIONS_DIR: codexDir,
      CLAUDESCOPE_HOME: home,
      DUCKDB_PATH: join(work, 'index.duckdb'),
      OPEN_BROWSER: '0',
      REINDEX_INTERVAL_MS: '0',
    },
    stdio: 'ignore',
  });

  let browser;
  try {
    await waitForHealth();

    // 3. Drive Chromium at a fixed retina viewport, once per theme.
    console.log('· launching chromium');
    browser = await chromium.launch();
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme,
      });
      // Pin the explicit theme choice so the app resolves to it regardless of
      // emulated OS appearance (mirrors THEME_STORAGE_KEY in ThemeProvider).
      await context.addInitScript((t) => {
        try {
          localStorage.setItem('claudescope-theme', t);
        } catch {
          /* ignore */
        }
      }, theme);

      const page = await context.newPage();
      for (const view of VIEWS) {
        await page.goto(`${BASE}${view.path}`, { waitUntil: 'networkidle' });
        await page.waitForSelector(view.ready, { timeout: 15_000 }).catch(() => {
          console.warn(`  ! ${view.name}: ready selector "${view.ready}" not found; capturing anyway`);
        });
        await sleep(700); // let Shiki / charts settle
        const file = join(outDir, `${view.name}-${theme}.png`);
        await page.screenshot({ path: file });
        console.log(`  ✓ ${view.name}-${theme}.png`);
      }
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    rmSync(work, { recursive: true, force: true });
  }

  console.log(`\nScreenshots written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
