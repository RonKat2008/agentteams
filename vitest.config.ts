import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@agentteams/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@agentteams/hub/core': fileURLToPath(new URL('./packages/hub/src/core.ts', import.meta.url)),
      '@agentteams/hub': fileURLToPath(new URL('./packages/hub/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Real git, child processes and in-process hubs: generous limits so busy machines don't flake.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: { include: ['packages/*/src/**'], exclude: ['**/bin.ts', '**/index.ts'] },
  },
});
