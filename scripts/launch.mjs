#!/usr/bin/env node
/**
 * One-command launcher for the Session Viewer.
 *
 * Ensures the app is built (builds on first run or after a clean), then starts
 * the Fastify server which serves both the API and the web UI on a single port,
 * and opens the browser. Honors PORT and CLAUDE_PROJECTS_DIR from the env.
 *
 *   npm start                                  # default ~/.claude/projects, :4317
 *   PORT=8080 npm start                        # custom port
 *   CLAUDE_PROJECTS_DIR=/path/to/projects npm start
 */

import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const serverEntry = join(repoRoot, 'packages', 'server', 'dist', 'index.js');
const webIndex = join(repoRoot, 'packages', 'web', 'dist', 'index.html');

// Build only when the compiled output is missing, so repeat launches are fast.
if (!existsSync(serverEntry) || !existsSync(webIndex)) {
  console.log('› Building the app (first run)…');
  const build = spawnSync(npm, ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('✗ Build failed. See output above.');
    process.exit(build.status ?? 1);
  }
}

// Start the server; it prints a banner and (with OPEN_BROWSER=1) opens the UI.
const child = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, OPEN_BROWSER: process.env.OPEN_BROWSER ?? '1' },
});

// Forward termination signals so Ctrl-C cleanly stops the server.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code) => process.exit(code ?? 0));
