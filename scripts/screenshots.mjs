#!/usr/bin/env node
/**
 * Capture the README screenshots — every canonical view in both light and dark
 * themes — fully automated and reproducible.
 *
 *   npm run screenshots
 *
 * Pipeline: seed a synthetic ALL-EIGHT-AGENTS demo dataset into a temp area, boot
 * the built server against it (every agent source AND the index/home isolated to
 * the temp dir, so no real agent data is read and the real index is never
 * touched), then drive Chromium via Playwright to shoot each view at a fixed
 * retina viewport. Output: docs/screenshots/{view}-{light,dark}.png for browse,
 * session, search, analytics, efficiency, memory, live (all three lanes), agents
 * (one session's agent tree), extensions, and files (Files changed tab).
 *
 * Requires a production build first (`npm run build`) and the Playwright
 * Chromium browser (`npx playwright install chromium`).
 */

import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedLive } from './demo-seed-live.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SCREENSHOT_PORT ?? 4399);
const BASE = `http://127.0.0.1:${PORT}`;
const outDir = join(root, 'docs', 'screenshots');

// Canonical path: on macOS the tmpdir is behind a /var -> /private/var symlink, which
// would make every seeded path look like a symlink in the UI.
const work = realpathSync(mkdtempSync(join(tmpdir(), 'claudescope-shots-')));
// Per-agent home layout — KEEP IN SYNC with scripts/demo-seed.mjs (seeds <work>).
// Each connector's home is the parent of its sessions dir, so memory files
// (CLAUDE.md / AGENTS.md / copilot-instructions.md) resolve to distinct homes.
const claudeDir = join(work, 'claude', 'projects');
const codexDir = join(work, 'codex', 'sessions');
const junieDir = join(work, 'junie', 'sessions');
const piDir = join(work, 'pi', 'sessions');
const opencodeDir = join(work, 'opencode');
const copilotSessionsDir = join(work, 'copilot', 'session-state');
const geminiDir = join(work, 'gemini');
const antigravityCliDir = join(geminiDir, 'antigravity-cli');
const antigravityDir = join(geminiDir, 'antigravity');
const grokDir = join(work, 'grok', 'sessions');
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
  {
    // Lanes need sessions in every state at once; `fresh` re-seeds them relative
    // to now just before the shot, so they hold however long the run has taken.
    name: 'live',
    path: '/live',
    ready: '.tv-live__lanes',
    fresh: true,
    prepare: async (page) => {
      // "Spend today" loads separately from the lanes; wait until it has a value.
      await page
        .waitForFunction(() => !/…/.test(document.querySelector('.tv-live__kpis')?.textContent ?? '…'), null, {
          timeout: 10_000,
        })
        .catch(() => {});
    },
  },
  // The focus view of one session: its agent tree and the messages between agents.
  { name: 'agents', path: '/live/live-agents', ready: '.tv-focus__tree', fresh: true },
  // One agent's full inventory: skills and subagents with usage, MCP servers, hooks, plugins.
  { name: 'extensions', path: '/extensions/claude-code', ready: '.tv-skills__table' },
  // A session that edited several files; the Files changed tab shows the first file's diff.
  { name: 'files', path: '/sessions/sess-files?tab=changes', ready: '.tv-changeset' },
];

// The machine's real home path must never reach a captured page or API response.
const realHome = homedir();
const leaks = new Set();
const checkLeak = (where, text) => {
  if (text.includes(realHome)) leaks.add(where);
};

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// Same layout `npm run bundle` ships (server.js beside web/ and pricing.default.json),
// kept under node_modules so the native @duckdb/node-api still resolves.
const appDir = join(root, 'node_modules', '.cache', 'claudescope-shots');

/**
 * Bundle the server the way a release does, with the real package version baked in
 * (a plain `tsc` build reports "0.0.0-dev"), so the sidebar label matches a release.
 */
async function bundleServer() {
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  await build({
    entryPoints: { server: join(root, 'packages', 'server', 'src', 'index.ts') },
    outdir: appDir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@duckdb/node-api'],
    define: { __CLAUDESCOPE_VERSION__: JSON.stringify(rootPkg.version) },
    banner: {
      js: [
        "import { createRequire as __cr } from 'node:module';",
        'const require = __cr(import.meta.url);',
      ].join('\n'),
    },
    logLevel: 'error',
  });
  cpSync(join(root, 'packages', 'web', 'dist'), join(appDir, 'web'), { recursive: true });
  cpSync(join(root, 'packages', 'server', 'pricing.json'), join(appDir, 'pricing.default.json'));
  // A non-dev build checks the registry for updates; answering from the 24h cache keeps
  // the run offline and the sidebar free of an "update available" nudge.
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'update-check.json'),
    JSON.stringify({ lastCheck: Date.now(), latest: rootPkg.version }),
  );
}

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

/** Re-seed the live sessions relative to now and make the server index them. */
async function refreshLive() {
  seedLive(work);
  const res = await fetch(`${BASE}/api/indexer/restart`, { method: 'POST' });
  if (!res.ok) throw new Error(`indexer restart failed: ${res.status}`);
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  // 1. Seed the synthetic all-eight-agents dataset under <work>.
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
  await bundleServer();
  const server = spawn('node', [join(appDir, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      CLAUDE_PROJECTS_DIR: claudeDir,
      CODEX_SESSIONS_DIR: codexDir,
      JUNIE_SESSIONS_DIR: junieDir,
      PI_SESSIONS_DIR: piDir,
      OPENCODE_DATA_DIR: opencodeDir,
      COPILOT_SESSIONS_DIR: copilotSessionsDir,
      ANTIGRAVITY_CLI_DIR: antigravityCliDir,
      ANTIGRAVITY_DIR: antigravityDir,
      GROK_SESSIONS_DIR: grokDir,
      OPENCODE_CONFIG_DIR: join(work, '.config', 'opencode'),
      // Any home-relative lookup (tilde display, ~/.agents/skills, XDG defaults)
      // resolves inside the temp tree, never the real home.
      HOME: work,
      USERPROFILE: work,
      XDG_CONFIG_HOME: join(work, '.config'),
      XDG_DATA_HOME: join(work, '.local', 'share'),
      XDG_STATE_HOME: join(work, '.local', 'state'),
      XDG_CACHE_HOME: join(work, '.cache'),
      // The json/fts extensions are a ~31 MB download; reuse the machine's cache
      // (a directory of binaries, never rendered) instead of re-fetching into the temp home.
      ...(existsSync(join(realHome, '.claudescope', 'duckdb-extensions'))
        ? { DUCKDB_EXTENSION_DIR: join(realHome, '.claudescope', 'duckdb-extensions') }
        : {}),
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
      page.on('response', async (res) => {
        if (!res.url().startsWith(`${BASE}/api/`)) return;
        const body = await res.text().catch(() => '');
        checkLeak(`${theme} API ${new URL(res.url()).pathname}`, body);
      });
      for (const view of VIEWS) {
        if (view.fresh) await refreshLive();
        await page.goto(`${BASE}${view.path}`, { waitUntil: 'networkidle' });
        await page.waitForSelector(view.ready, { timeout: 15_000 }).catch(() => {
          console.warn(`  ! ${view.name}: ready selector "${view.ready}" not found; capturing anyway`);
        });
        if (view.prepare) await view.prepare(page);
        await sleep(700); // let Shiki / charts settle
        checkLeak(`${theme} page ${view.name}`, await page.content());
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

  if (leaks.size > 0) {
    throw new Error(`real home path leaked into: ${[...leaks].join(', ')}`);
  }
  console.log(`\nScreenshots written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
