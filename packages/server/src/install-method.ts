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

/** Where this bundle really sits — in the published package `cli.js`/`server.js`
 *  are at the package top level, so this is the installed package root. */
export function installedPackageRoot(): string {
  try {
    return realpathSync(__dirname);
  } catch {
    return __dirname; /* keep __dirname if the path can't be resolved */
  }
}

/** Classify how this package was installed from where its bundle resides.
 *  Homebrew symlinks the bin out of the Cellar's libexec (realpath resolves it
 *  back); Nix installs under /nix/store; everything else (npm global, npx) is
 *  treated as npm. */
export function detectInstallMethod(): InstallMethod {
  const p = installedPackageRoot();
  if (p.includes('/nix/store/')) return 'nix';
  // Match the formula's Cellar dir specifically (…/Cellar/claudescope/<version>/…),
  // not a generic "homebrew" — a plain `npm i -g` under Homebrew's own Node lives
  // at …/homebrew/lib/node_modules/… and must NOT be mistaken for a brew install.
  if (/[\\/]Cellar[\\/]claudescope[\\/]/.test(p)) return 'brew';
  return 'npm';
}

/** The tree a `claudescope` bin must resolve into before the daemon may execute
 *  it (see self-restart.ts), derived from this install's own package root:
 *  npm (`…/lib/node_modules/@vladar107/claudescope`) → the dir holding the last
 *  `node_modules`, which also covers the global bin symlink and the Windows
 *  `.cmd` shim beside it; brew (`…/Cellar/claudescope/<v>/libexec/…`) →
 *  `…/Cellar/claudescope/`, because `brew upgrade` installs into a SIBLING
 *  version dir; nix → `/nix/store/`, root-owned and immutable, and an upgrade
 *  lands under a different store hash entirely.
 *
 *  Deliberately a PREFIX of this install's own path rather than a
 *  "…/node_modules/@vladar107/claudescope/… appears anywhere" match: an attacker
 *  who owns a directory on PATH can simply build that suffix underneath it.
 *  Roots always end in a separator, so `startsWith` cannot match a sibling like
 *  `…/lib-evil/`. Null when the layout yields no root (a dev checkout has no
 *  `node_modules` segment) — the caller then skips the restart entirely. */
export function trustedInstallRoot(packageRoot: string, method: InstallMethod): string | null {
  if (method === 'nix') return '/nix/store/';
  if (method === 'brew') {
    const cellar = /^.*?[\\/]Cellar[\\/]claudescope[\\/]/.exec(packageRoot);
    return cellar ? cellar[0] : null;
  }
  let sep = -1;
  for (const m of packageRoot.matchAll(/[\\/]node_modules(?=[\\/]|$)/g)) sep = m.index;
  return sep < 0 ? null : packageRoot.slice(0, sep + 1);
}

/** Whether a resolved bin path lies inside {@link trustedInstallRoot}. Windows
 *  paths compare case-insensitively (a `.cmd` shim reached as `C:\Users\Me\…`
 *  and as `c:\users\me\…` is the same file). */
export function isWithinInstallRoot(
  realBinPath: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    return realBinPath.toLowerCase().startsWith(root.toLowerCase());
  }
  return realBinPath.startsWith(root);
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
