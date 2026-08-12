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
 *
 * Read-only query subcommands (search/sessions/session/projects/analytics)
 * proxy the daemon's HTTP API for terminals and scripts (`--json`); see
 * agent/query.ts.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  APP_VERSION,
  CLAUDESCOPE_HOME,
  PORT as DEFAULT_PORT,
  autoRestartEnabled,
  ensureStateDir,
} from './config.js';
import { claudeProjectsDir, openBrowserOnStart } from './settings.js';
import {
  DAEMON_FILE,
  EXIT_WAIT_MS,
  LOG_FILE,
  classifyExisting,
  daemonOwnsPid,
  fetchDaemonHealth,
  isAlive,
  isHealthy,
  planWedgeAction,
  readDaemon,
  spawnDaemon,
  terminateDaemon,
  waitForExit,
  waitForHealth,
} from './daemon.js';
import { runMcpServer } from './agent/mcp.js';
import { ApiClient } from './agent/api-client.js';
import {
  queryAnalytics,
  queryDigest,
  queryProjects,
  querySearch,
  querySession,
  querySessions,
} from './agent/query.js';
import { ensureDaemon } from './daemon.js';
import { PKG, getLatestVersion, isNewer } from './update-check.js';
import { detectInstallMethod } from './install-method.js';
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

/** Start the server in the background, idempotently. */
async function start(port: number, open: boolean): Promise<void> {
  ensureStateDir();

  const existing = readDaemon();
  const state = await classifyExisting(existing, isAlive, isHealthy);
  if (state === 'healthy' && existing) {
    // A healthy daemon left over from a previous install still runs old code
    // (and an old index schema). Restart it into this CLI's version instead of
    // adopting it — CLAUDESCOPE_AUTO_RESTART=0 keeps the old warn-and-adopt.
    const runningVersion = (await fetchDaemonHealth(existing.port))?.version;
    const skewed = runningVersion !== undefined && runningVersion !== APP_VERSION;
    if (!skewed || !autoRestartEnabled()) {
      if (skewed) {
        console.log(
          `⚠ running daemon is v${runningVersion}, this CLI is v${APP_VERSION} ` +
            '(auto-restart disabled — run `claudescope restart` to align them)',
        );
      }
      console.log(`✓ claudescope is already running → ${existing.url}`);
      if (open) openBrowser(existing.url);
      return;
    }
    console.log(`› Running daemon is v${runningVersion}, this CLI is v${APP_VERSION} — restarting it…`);
    try {
      await terminateDaemon(existing);
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    // Fall through to spawn the current version below.
  }
  // Clear a stale record left by a crashed/killed process.
  if (state === 'stale') rmSync(DAEMON_FILE, { force: true });
  // Alive but unhealthy: a wedged server still holding the port. Replace it —
  // SIGTERM and wait for it to exit, rather than spawning a second server that
  // would fail to bind (EADDRINUSE) and leave the old one orphaned.
  if (state === 'wedged' && existing) {
    // Only signal a PID we can confirm is ours — after a crash + PID reuse it
    // belongs to an unrelated process (see planWedgeAction).
    const action = planWedgeAction(existing, daemonOwnsPid(existing.pid));
    if (action.kind === 'refuse') {
      console.error(`✗ ${action.message}`);
      process.exitCode = 1;
      return;
    }
    if (action.kind === 'discard') {
      console.log(`› ${action.message}`);
      rmSync(DAEMON_FILE, { force: true });
    } else {
      console.log(`claudescope (pid ${existing.pid}) is unresponsive; restarting it…`);
      try {
        await terminateDaemon(existing);
      } catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  const url = `http://localhost:${port}`;
  spawnDaemon(port);

  process.stdout.write('› Starting claudescope');
  const ok = await waitForHealth(port, 20000, () => process.stdout.write('.'));
  if (!ok) {
    console.error(`\n✗ Server did not become healthy on port ${port}.`);
    // The reason is almost always in the log the daemon just wrote to (a port
    // already in use, a bad PORT, a corrupt index). Printing the tail turns a
    // bare timeout into something actionable.
    const tail = logTail(15);
    if (tail) console.error(`\nLast lines of ${LOG_FILE}:\n${tail}`);
    console.error('\nFull log: claudescope logs');
    process.exitCode = 1;
    return;
  }
  console.log(`\n✓ claudescope running → ${url}`);
  console.log(`  Sessions: ${claudeProjectsDir()} (read-only)`);
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

/** Open the app root or an encoded session/message deep link, starting the
 *  daemon first when needed. Flag validation happens before daemon startup. */
async function openApp(session: string | undefined, around: string | undefined): Promise<void> {
  if (around !== undefined && session === undefined) {
    throw new UsageError('usage: claudescope open [--session id] [--around uuid]');
  }
  if (session !== undefined && session.length === 0) {
    throw new UsageError('--session expects a non-empty session id');
  }
  if (around !== undefined && around.length === 0) {
    throw new UsageError('--around expects a non-empty message uuid');
  }

  const d = await ensureDaemon();
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) {
    throw new UsageError('claudescope daemon returned an invalid port; run `claudescope restart`');
  }
  // daemon.json is local state but not a trusted navigation target. Rebuild the
  // URL from the ensured, validated port so `open` can only reach loopback.
  const baseUrl = `http://127.0.0.1:${d.port}`;
  const url = session
    ? `${baseUrl}/sessions/${encodeURIComponent(session)}${around ? `#${encodeURIComponent(around)}` : ''}`
    : baseUrl;
  openBrowser(url);
}

/** Last `n` lines of the daemon log, or '' when there is nothing to show.
 *  Used to explain a startup failure instead of just reporting the timeout. */
function logTail(n: number): string {
  try {
    return readFileSync(LOG_FILE, 'utf8').trimEnd().split('\n').slice(-n).join('\n');
  } catch {
    return '';
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

/** A bad flag value or missing argument on a query subcommand. */
class UsageError extends Error {}

/**
 * Parse `--port`. Rejects everything the server cannot listen on, because an
 * invalid value used to be recorded in daemon.json (NaN serializes to `null`)
 * and then polled for 20s while the daemon was already dead with
 * ERR_SOCKET_BAD_PORT. Port 0 is rejected too: it IS legal to listen on, but the
 * OS then picks the port, so the recorded one can never answer a health check.
 */
export function parsePort(raw: string | undefined, dflt: number): number {
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new UsageError(`--port expects an integer between 1 and 65535 (got '${raw}')`);
  }
  return n;
}

/** Parse a non-negative integer flag; undefined when absent, UsageError when bogus. */
function intFlag(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} expects a non-negative integer, got '${v}'`);
  return n;
}

/** Validate an enum-valued flag; undefined when absent, UsageError when bogus. */
function enumFlag<T extends string>(name: string, v: string | undefined, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new UsageError(`--${name} must be one of: ${allowed.join(', ')} (got '${v}')`);
  }
  return v as T;
}

/** Run one read-only query subcommand against the (auto-started) daemon and
 *  print its output. `prepare` validates flags and returns the command — it runs
 *  BEFORE the daemon is (maybe) spawned, so a bad flag never starts anything.
 *  Failures go to stderr with a non-zero exit; empty results are normal output
 *  ("No matches.") with exit 0. */
async function runQuery(prepare: () => (client: ApiClient) => Promise<string>): Promise<void> {
  try {
    const fn = prepare();
    const d = await ensureDaemon();
    const client = new ApiClient(`http://127.0.0.1:${d.port}`);
    console.log(await fn(client));
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
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
  open             Open the app, starting it first if needed
                   [--session id] [--around uuid]
  logs [-f]        Print the server log (-f / --follow to tail it)
  mcp              Run an MCP stdio server exposing transcript search/reading
                   (register with: claude mcp add claudescope -- claudescope mcp)
  update [-y]      Upgrade to the latest published version and restart
  pricing update   Fetch current model prices (LiteLLM) into the local rate table
  help             Show this help
  version          Print the installed version

Query commands (read-only; start the background server on first use):
  search "<query>" Full-text search across transcripts and agent memory
                   [--project id] [--role user|assistant] [--scope sessions|memory|all] [--limit N]
  sessions         List sessions [--project id] [--agent id]
                   [--sort recent|oldest|tokens|cost|messages] [--q substr] [--limit N]
  session <id>     One session as Markdown — a window of turns, pageable
                   [--offset N] [--limit N] [--around uuid] [--radius N]
                   [--max-tool-chars N] [--redact]
  projects         List projects
  analytics        Token/cost aggregates [--group-by project|model|day|agent] [--from date] [--to date]
  digest           Week-in-review Markdown [--from date] [--to date] (default: last 7 days)
  All query commands accept --json for the raw API response (ignores --redact).

Options:
  --port <n>       Port to listen on (default ${DEFAULT_PORT}, or $PORT)
  --no-open        Don't open the browser on start
  -y, --yes        Skip the confirmation prompt (for \`update\`)

State (index, pricing, logs, PID) lives in ${CLAUDESCOPE_HOME}
(override with $CLAUDESCOPE_HOME). Sessions are read from
${claudeProjectsDir()} (override with $CLAUDE_PROJECTS_DIR).
Settings edited in the web UI persist to settings.json in the state dir
(env vars always win over saved settings).
CLAUDESCOPE_AUTO_RESTART=0 disables automatic daemon restarts on version skew.`);
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
      // Query subcommand flags (search/sessions/session/projects/analytics).
      project: { type: 'string' },
      agent: { type: 'string' },
      role: { type: 'string' },
      scope: { type: 'string' },
      sort: { type: 'string' },
      q: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      session: { type: 'string' },
      around: { type: 'string' },
      radius: { type: 'string' },
      'max-tool-chars': { type: 'string' },
      redact: { type: 'boolean' },
      json: { type: 'boolean' },
      'group-by': { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
    },
  });

  const port = parsePort(values.port, DEFAULT_PORT);
  // Flag wins, then the persisted setting (which itself folds settings.json >
  // default true; the OPEN_BROWSER env var stays the launcher's contract).
  const open = values['no-open'] ? false : openBrowserOnStart();

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
      await openApp(values.session, values.around);
      break;
    case 'logs':
      logs(Boolean(values.follow));
      break;
    case 'mcp':
      // Stdio MCP server: stdout is the protocol channel — nothing else may
      // print to it. The server ensures the daemon on first tool use.
      await runMcpServer();
      break;
    case 'search':
      await runQuery(() => {
        const query = positionals[1];
        if (!query) throw new UsageError('usage: claudescope search "<query>" [--project id] [--role user|assistant] [--scope sessions|memory|all] [--limit N] [--json]');
        const args = {
          query,
          project: values.project,
          role: enumFlag('role', values.role, ['user', 'assistant', 'all'] as const),
          scope: enumFlag('scope', values.scope, ['sessions', 'memory', 'all'] as const),
          limit: intFlag('limit', values.limit),
          json: values.json,
        };
        return (client) => querySearch(client, args);
      });
      break;
    case 'sessions':
      await runQuery(() => {
        const args = {
          project: values.project,
          agent: values.agent,
          sort: enumFlag('sort', values.sort, ['recent', 'oldest', 'tokens', 'cost', 'messages'] as const),
          q: values.q,
          limit: intFlag('limit', values.limit),
          json: values.json,
        };
        return (client) => querySessions(client, args);
      });
      break;
    case 'session':
      await runQuery(() => {
        const id = positionals[1];
        if (!id) throw new UsageError('usage: claudescope session <id> [--offset N] [--limit N] [--around uuid] [--radius N] [--max-tool-chars N] [--redact] [--json]');
        const args = {
          offset: intFlag('offset', values.offset),
          limit: intFlag('limit', values.limit),
          around: values.around,
          radius: intFlag('radius', values.radius),
          maxToolChars: intFlag('max-tool-chars', values['max-tool-chars']),
          redact: values.redact,
          json: values.json,
        };
        return (client) => querySession(client, id, args);
      });
      break;
    case 'projects':
      await runQuery(() => (client) => queryProjects(client, { json: values.json }));
      break;
    case 'digest':
      await runQuery(() => {
        const args = { from: values.from, to: values.to, json: values.json };
        return (client) => queryDigest(client, args);
      });
      break;
    case 'analytics':
      await runQuery(() => {
        const args = {
          groupBy: enumFlag('group-by', values['group-by'], ['project', 'model', 'day', 'agent'] as const),
          from: values.from,
          to: values.to,
          json: values.json,
        };
        return (client) => queryAnalytics(client, args);
      });
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
    // A usage error is the user's typo, not a crash — print the message, not a
    // stack (matches how the query subcommands report bad flags).
    if (err instanceof UsageError) console.error(`✗ ${err.message}`);
    else console.error(err);
    process.exit(1);
  });
}
