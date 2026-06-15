/** Shared path display helpers. */

import { homedir } from 'node:os';

/** Contract a leading home-dir prefix to `~` for display (e.g. `~/.claude/...`). */
export function contractHome(p: string): string {
  const home = homedir();
  if (p === home) return '~';
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}
