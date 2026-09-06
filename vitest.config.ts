import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // The source uses NodeNext `.js` import specifiers that point at `.ts`
    // files — resolve those to source so tests don't require a build.
    extensionAlias: { '.js': ['.ts', '.js'] },
    alias: {
      '@claudescope/shared': resolve(root, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts'],
    env: {
      // In production the json/fts extensions are downloaded into the state dir
      // (see DUCKDB_EXTENSION_DIR in config.ts), but tests spin up a throwaway
      // CLAUDESCOPE_HOME per file — which would re-download ~31 MB every time.
      // Pin them to the machine's own shared DuckDB cache instead.
      DUCKDB_EXTENSION_DIR: join(homedir(), '.duckdb', 'extensions'),
      // The suite asserts search right after a pass, so rebuild FTS every pass;
      // the debounce itself has its own test, which sets its own window.
      FTS_REBUILD_MIN_INTERVAL_MS: '0',
    },
    // Integration tests build a DuckDB index from fixtures; give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // On Windows, parallel workers concurrently `INSTALL` DuckDB extensions into
    // that shared cache, and the OS file-locking fails the simultaneous move
    // ("Access is denied"). The app is single-process in production, so this
    // is purely a test-concurrency artifact — serialize test files on Windows
    // only; Linux/macOS keep full parallelism.
    fileParallelism: process.platform !== 'win32',
  },
});
