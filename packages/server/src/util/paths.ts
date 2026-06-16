/** Shared path display helpers. */

import { homedir } from 'node:os';

/** Contract a leading home-dir prefix to `~` for display (e.g. `~/.claude/...`).
 *  Accepts either separator after the home prefix so it also works on Windows
 *  (`C:\Users\me\.claude\...` → `~\.claude\...`). */
export function contractHome(p: string): string {
  const home = homedir();
  if (p === home) return '~';
  const boundary = p[home.length];
  if (p.startsWith(home) && (boundary === '/' || boundary === '\\')) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}
