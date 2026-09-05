/**
 * Unit tests for the install-root trust rules in install-method.ts — the gate
 * that decides which `claudescope` on PATH the daemon may execute for a
 * self-restart. The rules are pure string work over the four real layouts (npm
 * global, npm on Windows, Homebrew Cellar, Nix store) plus the ones that must
 * yield NO root, so they are tested without touching the filesystem.
 *
 * CLAUDESCOPE_HOME is set before importing the module (config.ts reads env at
 * import time).
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CLAUDESCOPE_HOME = mkdtempSync(join(tmpdir(), 'claudescope-install-'));

const im = await import('../src/install-method.js');

const NPM_ROOT = '/opt/homebrew/lib/node_modules/@vladar107/claudescope';
const WIN_ROOT = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@vladar107\\claudescope';
const BREW_ROOT =
  '/opt/homebrew/Cellar/claudescope/0.20.0/libexec/lib/node_modules/@vladar107/claudescope';
const NIX_ROOT = '/nix/store/abc123-claudescope-0.20.0/lib/node_modules/@vladar107/claudescope';
const VOLTA_ROOT =
  '/Users/me/.volta/tools/image/packages/claudescope/lib/node_modules/@vladar107/claudescope';

describe('trustedInstallRoot', () => {
  it('npm global: the dir holding node_modules, so the bin symlink beside it counts', () => {
    expect(im.trustedInstallRoot(NPM_ROOT, 'npm')).toBe('/opt/homebrew/lib/');
  });

  it('npm on Windows: backslash separators, so the .cmd shim dir counts', () => {
    expect(im.trustedInstallRoot(WIN_ROOT, 'npm')).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\');
  });

  it('npx cache: the LAST node_modules wins, not the first', () => {
    expect(
      im.trustedInstallRoot('/Users/me/.npm/_npx/abc/node_modules/@vladar107/claudescope', 'npm'),
    ).toBe('/Users/me/.npm/_npx/abc/');
  });

  it('brew: stops at Cellar/claudescope so the next version dir stays trusted', () => {
    expect(im.trustedInstallRoot(BREW_ROOT, 'brew')).toBe('/opt/homebrew/Cellar/claudescope/');
  });

  it('brew without a Cellar segment yields no root', () => {
    expect(im.trustedInstallRoot('/opt/homebrew/lib/node_modules/x', 'brew')).toBeNull();
  });

  it('nix: the whole (immutable, root-owned) store, since an upgrade changes the hash', () => {
    expect(im.trustedInstallRoot(NIX_ROOT, 'nix')).toBe('/nix/store/');
  });

  it('dev checkout has no node_modules segment — no root, so no self-restart', () => {
    expect(
      im.trustedInstallRoot('/Users/me/src/claudescope/packages/server/dist', 'npm'),
    ).toBeNull();
  });

  it('a dir merely NAMED node_modules-something is not the segment', () => {
    expect(im.trustedInstallRoot('/opt/node_modules_evil/claudescope', 'npm')).toBeNull();
  });
});

describe('isWithinInstallRoot', () => {
  it('accepts the npm global bin symlink target', () => {
    const root = im.trustedInstallRoot(NPM_ROOT, 'npm')!;
    expect(im.isWithinInstallRoot(`${NPM_ROOT}/cli.js`, root, 'linux')).toBe(true);
  });

  it('accepts a Windows shim reached in different letter case', () => {
    const root = im.trustedInstallRoot(WIN_ROOT, 'npm')!;
    const shim = 'c:\\users\\me\\appdata\\roaming\\npm\\claudescope.cmd';
    expect(im.isWithinInstallRoot(shim, root, 'win32')).toBe(true);
    expect(im.isWithinInstallRoot(shim, root, 'linux')).toBe(false);
  });

  it('accepts the sibling version dir a brew upgrade installs into', () => {
    const root = im.trustedInstallRoot(BREW_ROOT, 'brew')!;
    const upgraded = '/opt/homebrew/Cellar/claudescope/0.21.0/libexec/bin/claudescope';
    expect(im.isWithinInstallRoot(upgraded, root, 'darwin')).toBe(true);
  });

  it('accepts a new nix store path', () => {
    const root = im.trustedInstallRoot(NIX_ROOT, 'nix')!;
    expect(
      im.isWithinInstallRoot('/nix/store/def456-claudescope-0.21.0/bin/claudescope', root, 'linux'),
    ).toBe(true);
  });

  it('rejects a Volta shim: its bin dir is outside the package tree', () => {
    const root = im.trustedInstallRoot(VOLTA_ROOT, 'npm')!;
    expect(im.isWithinInstallRoot('/Users/me/.volta/bin/claudescope', root, 'darwin')).toBe(false);
  });

  it('rejects a plain copy dropped on PATH', () => {
    const root = im.trustedInstallRoot(NPM_ROOT, 'npm')!;
    expect(im.isWithinInstallRoot('/usr/local/bin/claudescope', root, 'linux')).toBe(false);
  });

  it('rejects a bin from a different brew formula', () => {
    const root = im.trustedInstallRoot(BREW_ROOT, 'brew')!;
    expect(
      im.isWithinInstallRoot('/opt/homebrew/Cellar/other/1.0/bin/claudescope', root, 'darwin'),
    ).toBe(false);
  });

  it('rejects a sibling dir sharing the root prefix (roots end in a separator)', () => {
    const root = im.trustedInstallRoot(NPM_ROOT, 'npm')!;
    expect(im.isWithinInstallRoot('/opt/homebrew/lib-evil/claudescope', root, 'linux')).toBe(false);
  });
});
