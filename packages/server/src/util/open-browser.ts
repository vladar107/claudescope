/** Open a URL in the user's default browser (best-effort, cross-platform). */

import { spawn } from 'node:child_process';

/** Launch the platform browser opener detached; non-fatal on failure (callers
 *  print the URL regardless). Shared by the CLI and the server entrypoint. */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    }).unref();
  } catch {
    /* non-fatal: the URL is printed regardless */
  }
}
