/**
 * Claudescope lifecycle CLI — the package `bin`.
 *
 * Manages a single long-lived server as a detached background process tracked
 * by a PID file in the state dir (~/.claudescope). No external supervisor: we
 * spawn the server bundle detached, record {pid, port, …} in daemon.json, and
 * the subcommands (start/stop/status/restart/logs/open/update) act on it.
 *
 *   claudescope            # start in the background (default), open the browser
 *   claudescope stop       # stop the background server
 *   claudescope status     # is it running? is an update available?
 *   claudescope logs -f    # follow the server log
 *   claudescope update     # upgrade to the latest published version
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, CLAUDE_PROJECTS_DIR, CLAUDESCOPE_HOME, PORT as DEFAULT_PORT } from './config.js';
import {
  DAEMON_FILE,
  EXIT_WAIT_MS,
  LOG_FILE,
  classifyExisting,
  isAlive,
  isHealthy,
  readDaemon,
  spawnDaemon,
  waitForExit,
  waitForHealth,
} from './daemon.js';
import { runMcpServer } from './agent/mcp.js';
import { refreshPricing } from './data/pricing-refresh.js';
import { openBrowser } from './util/open-browser.js';

// Daemon lifecycle primitives live in daemon.js (shared with the MCP server);
// re-exported here so existing importers (tests) keep working.
export {
  classifyExisting,
  isAlive,
  isHealthy,
  readDaemon,
  waitForExit,
  waitForHealth,
  type DaemonRecord,
  type ExistingState,
} from './daemon.js';

const UPDATE_CHECK_FILE = join(CLAUDESCOPE_HOME, 'update-check.json');
const PKG = '@vladar107/claudescope';
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** Start the server in the background, idempotently. */
async function start(port: number, open: boolean): Promise<void> {
  mkdirSync(CLAUDESCOPE_HOME, { recursive: true });

  const existing = readDaemon();
  const state = await classifyExisting(existing, isAlive, isHealthy);
  if (state === 'healthy' && existing) {
    console.log(`✓ claudescope is already running → ${existing.url}`);
    if (open) openBrowser(existing.url);
    return;
  }
  // Clear a stale record left by a crashed/killed process.
  if (state === 'stale') rmSync(DAEMON_FILE, { force: true });
  // Alive but unhealthy: a wedged server still holding the port. Replace it —
  // SIGTERM and wait for it to exit, rather than spawning a second server that
  // would fail to bind (EADDRINUSE) and leave the old one orphaned.
  if (state === 'wedged' && existing) {
    console.log(`claudescope (pid ${existing.pid}) is unresponsive; restarting it…`);
    try {
      process.kill(existing.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    if (!(await waitForExit(existing.pid, EXIT_WAIT_MS))) {
      console.error(
        `✗ Could not stop the unresponsive process (pid ${existing.pid}). ` +
          `Kill it manually and retry: kill -9 ${existing.pid}`,
      );
      process.exitCode = 1;
      return;
    }
    rmSync(DAEMON_FILE, { force: true });
  }

  const url = `http://localhost:${port}`;
  spawnDaemon(port);

  process.stdout.write('› Starting claudescope');
  const ok = await waitForHealth(port, 20000, () => process.stdout.write('.'));
  if (!ok) {
    console.error(`\n✗ Server did not become healthy in time. Inspect: claudescope logs`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n✓ claudescope running → ${url}`);
  console.log(`  Sessions: ${CLAUDE_PROJECTS_DIR} (read-only)`);
  if (open) openBrowser(url);
  await maybeNotifyUpdate(false);
}

/** Stop the background server. Waits for the process to actually exit before
 *  clearing the record so a following `restart`/`update` can rebind the port. */
async function stop(): Promise<void> {
  const d = readDaemon();
  if (!d || !isAlive(d.pid)) {
    console.log('claudescope is not running.');
    rmSync(DAEMON_FILE, { force: true });
    return;
  }
  try {
    process.kill(d.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  await waitForExit(d.pid, EXIT_WAIT_MS);
  rmSync(DAEMON_FILE, { force: true });
  console.log(`✓ Stopped claudescope (pid ${d.pid}).`);
}

/** Report whether the server is running and whether an update is available. */
async function status(): Promise<void> {
  const d = readDaemon();
  if (d && isAlive(d.pid) && (await isHealthy(d.port))) {
    console.log(`● running   ${d.url}   (pid ${d.pid}, v${d.version})`);
  } else {
    console.log(`○ stopped   (installed v${APP_VERSION})`);
  }
  await maybeNotifyUpdate(true);
}

/** Open the running app, or hint to start it first. */
function openApp(): void {
  const d = readDaemon();
  if (d && isAlive(d.pid)) {
    openBrowser(d.url);
  } else {
    console.log('claudescope is not running. Start it with: claudescope start');
  }
}

/** Print the server log; with `follow`, tail it (Unix only). */
function logs(follow: boolean): void {
  if (!existsSync(LOG_FILE)) {
    console.log('No logs yet.');
    return;
  }
  if (follow && process.platform !== 'win32') {
    spawnSync('tail', ['-f', LOG_FILE], { stdio: 'inherit' });
  } else {
    process.stdout.write(readFileSync(LOG_FILE, 'utf8'));
  }
}

/** Ask a yes/no question on the terminal. Returns `defaultYes` on a bare Enter
 *  or when stdin isn't interactive (so piped/CI invocations don't hang). */
async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `))
      .trim()
      .toLowerCase();
    if (!answer) return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

type InstallMethod = 'brew' | 'nix' | 'npm';

/** Classify how this CLI was installed from where its bundle resides. Homebrew
 *  symlinks the bin out of the Cellar's libexec (realpath resolves it back); Nix
 *  installs under /nix/store; everything else (npm global, npx) is treated as npm. */
function detectInstallMethod(): InstallMethod {
  let p = __dirname;
  try {
    p = realpathSync(__dirname);
  } catch {
    /* keep __dirname if the path can't be resolved */
  }
  if (p.includes('/nix/store/')) return 'nix';
  // Match the formula's Cellar dir specifically (…/Cellar/claudescope/<version>/…),
  // not a generic "homebrew" — a plain `npm i -g` under Homebrew's own Node lives
  // at …/homebrew/lib/node_modules/… and must NOT be mistaken for a brew install.
  if (/[\\/]Cellar[\\/]claudescope[\\/]/.test(p)) return 'brew';
  return 'npm';
}

/** Upgrade the global install to the latest published version and restart.
 *  Resolves the target version and confirms before installing; `--yes` (or a
 *  non-interactive stdin) skips the prompt. Installs the hardcoded package only.
 *  For package-manager-managed installs (brew/nix), defers to that manager. */
async function update(skipConfirm: boolean): Promise<void> {
  const latest = await getLatestVersion(true);
  if (latest && !isNewer(latest, APP_VERSION)) {
    console.log(`✓ Already on the latest version (v${APP_VERSION}).`);
    return;
  }

  // Running `npm install -g` over a brew-/nix-managed install would corrupt it —
  // defer to the manager's own upgrade command instead.
  const method = detectInstallMethod();
  if (method === 'brew') {
    console.log('claudescope was installed via Homebrew.');
    console.log('  Run: brew upgrade vladar107/tap/claudescope');
    return;
  }
  if (method === 'nix') {
    console.log('claudescope was installed via Nix.');
    console.log('  Run: nix profile upgrade claudescope');
    console.log('  (flake users: re-run `nix run --refresh github:vladar107/claudescope`)');
    return;
  }
  if (!latest) {
    console.log('⚠ Could not reach the npm registry to confirm the latest version.');
  }
  const target = latest ? `v${APP_VERSION} → v${latest}` : `v${APP_VERSION} → latest`;
  console.log(`› Will run: npm install -g ${PKG}@latest  (${target})`);
  if (!skipConfirm && !(await confirm('Proceed?', true))) {
    console.log('Aborted.');
    return;
  }
  console.log(`› Updating ${PKG}…`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npm, ['install', '-g', `${PKG}@latest`], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(
      `✗ Update failed. If you run via npx, just re-run \`npx ${PKG}\` to get the latest.`,
    );
    process.exitCode = 1;
    return;
  }
  // Stop the old daemon, then start via PATH so the freshly-installed binary
  // (new code) supervises the new server, not this now-stale process.
  await stop();
  console.log('✓ Updated. Restarting…');
  spawnSync('claudescope', ['start'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

/** Compare two `x.y.z` versions; true if `a` is strictly newer than `b`. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

/** Latest published version, cached for 24h. Null on any failure (offline). */
async function getLatestVersion(force: boolean): Promise<string | null> {
  const now = Date.now();
  if (!force && existsSync(UPDATE_CHECK_FILE)) {
    try {
      const cached = JSON.parse(readFileSync(UPDATE_CHECK_FILE, 'utf8')) as {
        lastCheck: number;
        latest: string;
      };
      if (now - cached.lastCheck < UPDATE_CHECK_TTL_MS) return cached.latest;
    } catch {
      /* fall through to a fresh fetch */
    }
  }
  const url = `https://registry.npmjs.org/${PKG.replaceAll('/', '%2f')}/latest`;
  const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) return null;
  const json = (await res.json()) as { version?: string };
  if (!json.version) return null;
  mkdirSync(CLAUDESCOPE_HOME, { recursive: true });
  writeFileSync(UPDATE_CHECK_FILE, JSON.stringify({ lastCheck: now, latest: json.version }));
  return json.version;
}

/** Print an update notice if a newer version exists. Never throws. */
async function maybeNotifyUpdate(force: boolean): Promise<void> {
  try {
    const latest = await getLatestVersion(force);
    if (latest && isNewer(latest, APP_VERSION)) {
      console.log(`\n  ⬆ Update available: v${APP_VERSION} → v${latest}.  Run: claudescope update`);
    }
  } catch {
    /* offline or registry hiccup — staying quiet is the right call */
  }
}

/** Run a one-shot pricing refresh and print a concise summary. */
async function pricingUpdate(): Promise<void> {
  try {
    const { modelCount, changed, path } = await refreshPricing();
    console.log(`✓ Pricing updated: ${modelCount} models (${changed} changed) → ${path}`);
    console.log('  A running server picks up the new rates automatically (newly indexed events).');
  } catch (err) {
    console.error(`✗ Pricing update failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error('  Existing rates are unchanged.');
    process.exitCode = 1;
  }
}

/** Print brief usage for the pricing subcommand. */
function pricingHelp(): void {
  console.log(`Usage: claudescope pricing <subcommand>

Subcommands:
  update    Fetch current model prices (LiteLLM) into the local rate table`);
}

function help(): void {
  console.log(`claudescope v${APP_VERSION} — local viewer for Claude Code transcripts

Usage: claudescope [command] [options]

Commands:
  start            Start the server in the background (default), open the browser
  stop             Stop the background server
  restart          Restart the background server
  status           Show whether the server is running and if an update exists
  open             Open the running app in your browser
  logs [-f]        Print the server log (-f / --follow to tail it)
  mcp              Run an MCP stdio server exposing transcript search/reading
                   (register with: claude mcp add claudescope -- claudescope mcp)
  update [-y]      Upgrade to the latest published version and restart
  pricing update   Fetch current model prices (LiteLLM) into the local rate table
  help             Show this help
  version          Print the installed version

Options:
  --port <n>       Port to listen on (default ${DEFAULT_PORT}, or $PORT)
  --no-open        Don't open the browser on start
  -y, --yes        Skip the confirmation prompt (for \`update\`)

State (index, pricing, logs, PID) lives in ${CLAUDESCOPE_HOME}
(override with $CLAUDESCOPE_HOME). Sessions are read from
${CLAUDE_PROJECTS_DIR} (override with $CLAUDE_PROJECTS_DIR).`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      follow: { type: 'boolean', short: 'f' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      yes: { type: 'boolean', short: 'y' },
      // parseArgs has no built-in negation, so the flag is literally `no-open`.
      'no-open': { type: 'boolean' },
    },
  });

  const port = values.port ? Number(values.port) : DEFAULT_PORT;
  const open = !values['no-open'];

  let command = positionals[0];
  if (!command) command = values.help ? 'help' : values.version ? 'version' : 'start';

  switch (command) {
    case 'start':
      await start(port, open);
      break;
    case 'stop':
      await stop();
      break;
    case 'restart':
      await stop();
      await start(port, open);
      break;
    case 'status':
      await status();
      break;
    case 'open':
      openApp();
      break;
    case 'logs':
      logs(Boolean(values.follow));
      break;
    case 'mcp':
      // Stdio MCP server: stdout is the protocol channel — nothing else may
      // print to it. The server ensures the daemon on first tool use.
      await runMcpServer();
      break;
    case 'update':
      await update(Boolean(values.yes));
      break;
    case 'pricing': {
      const sub = positionals[1];
      if (sub === 'update') {
        await pricingUpdate();
      } else {
        pricingHelp();
      }
      break;
    }
    case 'version':
      console.log(APP_VERSION);
      break;
    case 'help':
      help();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      help();
      process.exitCode = 1;
  }
}

/** True only when this module is the process entrypoint (the real CLI launch),
 *  so importing it (e.g. from tests) does not execute a command. realpathSync on
 *  both sides handles the Homebrew bin symlink the same way detectInstallMethod does. */
function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
