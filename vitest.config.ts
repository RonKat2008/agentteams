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
    // No test may start a real detached `agentteams sync` (it would run with the real HOME), and real git never reads
    // the developer's global or system config (gpgsign, hooksPath, defaultBranch, ...); tests that need a git identity
    // set it themselves.
    env: { AGENTTEAMS_NO_BACKGROUND_SYNC: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    coverage: { include: ['packages/*/src/**'], exclude: ['**/bin.ts', '**/index.ts'] },
  },
});
