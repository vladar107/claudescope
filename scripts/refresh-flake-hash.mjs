#!/usr/bin/env node
/**
 * Refresh the flake's npmDepsHash to match the current package-lock.json.
 *
 * Wired into the npm `version` lifecycle (see package.json), this runs DURING
 * `npm version <bump>` — after the bump rewrites package.json + package-lock.json,
 * but before the version commit/tag — and `git add`s flake.nix so the new hash
 * lands in the tagged commit. fetch-npm-deps folds the lockfile into its hash, so
 * the hash changes on every version bump; this keeps the Nix build from breaking
 * at release time without a manual step.
 *
 * Requires Nix (the project ships a flake). Run manually anytime with:
 *   node scripts/refresh-flake-hash.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const flakePath = join(repoRoot, 'flake.nix');

let output;
try {
  output = execFileSync(
    'nix',
    [
      '--extra-experimental-features',
      'nix-command flakes',
      'run',
      'nixpkgs#prefetch-npm-deps',
      '--',
      'package-lock.json',
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
} catch {
  console.error(
    '✗ Could not compute npmDepsHash. Is Nix installed and on PATH?\n' +
      '  Releasing requires Nix (this project ships a flake). Install it, or\n' +
      '  update flake.nix manually, then re-run the version bump.',
  );
  process.exit(1);
}

const hash = output.match(/sha256-[A-Za-z0-9+/=]+/)?.[0];
if (!hash) {
  console.error(`✗ Unexpected prefetch-npm-deps output (no sha256- hash found).`);
  process.exit(1);
}

const flake = readFileSync(flakePath, 'utf8');
const updated = flake.replace(/npmDepsHash = "[^"]*";/, `npmDepsHash = "${hash}";`);
if (updated === flake && !flake.includes(`npmDepsHash = "${hash}";`)) {
  console.error('✗ Could not find an npmDepsHash line to update in flake.nix.');
  process.exit(1);
}
writeFileSync(flakePath, updated);
console.log(`✓ flake npmDepsHash → ${hash}`);
