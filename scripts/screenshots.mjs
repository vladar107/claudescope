#!/usr/bin/env node
/**
 * Capture the README screenshots — every canonical view in both light and dark
 * themes — fully automated and reproducible.
 *
 *   npm run screenshots
 *
 * Pipeline: seed a synthetic ALL-SIX-AGENTS demo dataset into a temp area, boot
 * the built server against it (every agent source AND the index/home isolated to
 * the temp dir, so no real agent data is read and the real index is never
 * touched), then drive Chromium via Playwright to shoot each view at a fixed
 * retina viewport. Output: docs/screenshots/{view}-{light,dark}.png.
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
// Per-agent home layout — KEEP IN SYNC with scripts/demo-seed.mjs (seeds <work>).
// Each connector's home is the parent of its sessions dir, so memory files
// (CLAUDE.md / AGENTS.md / copilot-instructions.md) resolve to distinct homes.
const claudeDir = join(work, 'claude', 'projects');
const codexDir = join(work, 'codex', 'sessions');
const junieDir = join(work, 'junie', 'sessions');
const piDir = join(work, 'pi', 'sessions');
const opencodeDir = join(work, 'opencode');
const copilotSessionsDir = join(work, 'copilot', 'session-state');
const home = join(work, '.state'); // CLAUDESCOPE_HOME (index/pricing); kept out of the agent-home dirs

const THEMES = /** @type {const} */ (['light', 'dark']);
/**
 * Each view: a path to visit, a selector that signals it has rendered, and an
 * optional `prepare(page)` to drive a control before the shot.
 */
const VIEWS = [
  { name: 'browse', path: '/', ready: '.tv-project-grid' },
  { name: 'session', path: '/sessions/sess-darkmode', ready: '.tv-session__header' },
  { name: 'search', path: '/search?q=theme', ready: '.tv-search__snippet' },
  {
    name: 'analytics',
    path: '/analytics',
    ready: '.recharts-surface',
    // Default group-by is "By project"; switch to the per-agent breakdown.
    prepare: async (page) => {
      await page.selectOption('#tv-group-by', 'agent').catch(() => {});
      await page.waitForSelector('.recharts-surface', { timeout: 5_000 }).catch(() => {});
    },
  },
  {
    name: 'efficiency',
    path: '/analytics',
    ready: '.tv-eff__table',
    // The Efficiency tab lands on the Agents grain — the comparison scorecard.
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Efficiency' }).click({ timeout: 5_000 });
      await page.waitForSelector('.tv-eff__table', { timeout: 10_000 });
    },
  },
  { name: 'memory', path: '/memory', ready: '.tv-project-grid' },
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

/**
 * `/api/health` flips ready slightly BEFORE the initial index build finishes, so
 * poll until projects actually exist — otherwise Browse can capture an empty
 * grid. Returns once the index has surfaced at least `min` projects.
 */
async function waitForIndex(min = 5, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/projects`);
      if (res.ok) {
        const data = await res.json();
        const projects = Array.isArray(data) ? data : (data.projects ?? []);
        if (projects.length >= min) return;
      }
    } catch {
      /* not indexed yet */
    }
    await sleep(300);
  }
  console.warn(`  ! index did not reach ${min} projects in time; capturing anyway`);
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  // 1. Seed the synthetic all-six-agents dataset under <work>.
  console.log('· seeding demo data');
  const seed = spawnSync('node', [join(root, 'scripts', 'demo-seed.mjs'), work], {
    stdio: 'inherit',
  });
  if (seed.status !== 0) throw new Error('demo-seed failed');

  // 2. Boot the built server against the demo data, fully isolated. EVERY agent
  //    source is pinned at the temp tree (so no real ~/.claude, ~/.codex,
  //    ~/.junie, ~/.pi, ~/.local/share/opencode, or ~/.copilot data is read),
  //    as are the index and home. Memory homes derive from each sessions dir's
  //    parent: CLAUDE_HOME → <work>/claude, CODEX_HOME → <work>/codex, etc.
  console.log('· starting server');
  const server = spawn('node', [join(root, 'packages', 'server', 'dist', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CLAUDE_PROJECTS_DIR: claudeDir,
      CODEX_SESSIONS_DIR: codexDir,
      JUNIE_SESSIONS_DIR: junieDir,
      PI_SESSIONS_DIR: piDir,
      OPENCODE_DATA_DIR: opencodeDir,
      COPILOT_SESSIONS_DIR: copilotSessionsDir,
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
    await waitForIndex();

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
        if (view.prepare) await view.prepare(page);
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
