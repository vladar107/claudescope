import { dirname, resolve } from 'node:path';
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
    // Integration tests build a DuckDB index from fixtures; give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
