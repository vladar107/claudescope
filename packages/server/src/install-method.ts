/**
 * Install-method detection, shared by the CLI (`update` defers to brew/nix)
 * and the server (`GET /api/system` shows the right upgrade command). Both
 * bundles (`cli.js`, `server.js`) are siblings in the published package, so
 * resolving from this module's own dir classifies either identically.
 */

import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PKG } from './update-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type InstallMethod = 'brew' | 'nix' | 'npm';

/** Classify how this package was installed from where its bundle resides.
 *  Homebrew symlinks the bin out of the Cellar's libexec (realpath resolves it
 *  back); Nix installs under /nix/store; everything else (npm global, npx) is
 *  treated as npm. */
export function detectInstallMethod(): InstallMethod {
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

/** The exact upgrade command for an install method (shown, never executed by
 *  the server — updates stay terminal-driven). */
export function updateCommandFor(method: InstallMethod): string {
  switch (method) {
    case 'brew':
      return 'brew upgrade vladar107/tap/claudescope';
    case 'nix':
      return 'nix profile upgrade claudescope';
    default:
      return `npm install -g ${PKG}@latest`;
  }
}
