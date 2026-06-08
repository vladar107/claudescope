#!/usr/bin/env node
/**
 * Assemble the publishable single-package artifact under `dist/`.
 *
 * The repo is a monorepo of three private workspaces, but we ship ONE public
 * package (@vladar107/claudescope). This script bundles the server (with the
 * shared lib inlined) into a single file, copies the built web assets and the
 * default pricing template alongside it, and writes a self-contained
 * package.json. The only runtime dependency left external is the native DuckDB
 * client, which npm installs from its own prebuilt binaries.
 *
 *   node scripts/bundle.mjs        # build web + shared, bundle, assemble dist/
 *
 * Test the result locally:
 *   npm pack ./dist                # -> vladar107-claudescope-<version>.tgz
 *   npm i -g ./vladar107-claudescope-<version>.tgz
 *   claudescope                    # serves http://localhost:4317
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const serverPkg = JSON.parse(
  readFileSync(join(repoRoot, 'packages', 'server', 'package.json'), 'utf8'),
);

/** Run an npm script in the repo, failing the build if it errors. */
function run(args) {
  const res = spawnSync(npm, args, { cwd: repoRoot, stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`✗ \`npm ${args.join(' ')}\` failed.`);
    process.exit(res.status ?? 1);
  }
}

console.log('› Cleaning dist/…');
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// The shared lib must be built first so esbuild can resolve and inline it; the
// web build produces the static assets we serve.
console.log('› Building shared + web…');
run(['-w', '@claudescope/shared', 'run', 'build']);
run(['-w', '@claudescope/web', 'run', 'build']);

// Bundle the server entrypoint into a single ESM file with a shebang so it can
// double as the package bin. The native DuckDB client stays external.
console.log('› Bundling server…');
await build({
  entryPoints: [join(repoRoot, 'packages', 'server', 'src', 'index.ts')],
  outfile: join(distDir, 'server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@duckdb/node-api'],
  // Shebang so the bundle doubles as the bin, plus a createRequire shim: several
  // runtime deps (fastify/avvio) are CommonJS and call require() internally. In
  // an ESM bundle esbuild's require shim throws unless a real `require` exists
  // in scope, so we define one (and the __dirname/__filename it implies).
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __ftp } from 'node:url';",
      "import { dirname as __dn } from 'node:path';",
      'const require = __cr(import.meta.url);',
      'const __filename = __ftp(import.meta.url);',
      'const __dirname = __dn(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
});

console.log('› Copying web assets + pricing default…');
cpSync(join(repoRoot, 'packages', 'web', 'dist'), join(distDir, 'web'), { recursive: true });
cpSync(
  join(repoRoot, 'packages', 'server', 'pricing.json'),
  join(distDir, 'pricing.default.json'),
);

// A self-contained manifest for the published package. Keeps only the runtime
// dependency (native DuckDB); everything else is inlined by the bundle.
const pkg = {
  name: '@vladar107/claudescope',
  version: rootPkg.version,
  description: 'Local viewer for Claude Code session transcripts.',
  license: rootPkg.license ?? 'MIT',
  type: 'module',
  bin: { claudescope: 'server.js' },
  files: ['server.js', 'web', 'pricing.default.json'],
  engines: rootPkg.engines,
  dependencies: {
    '@duckdb/node-api': serverPkg.dependencies['@duckdb/node-api'],
  },
};
writeFileSync(join(distDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

console.log(`✓ Assembled ${pkg.name}@${pkg.version} in dist/`);
console.log('  Test locally:  npm pack ./dist  &&  npm i -g ./vladar107-claudescope-' +
  pkg.version + '.tgz');
