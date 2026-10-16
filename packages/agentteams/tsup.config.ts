import { defineConfig } from 'tsup';
import type { Plugin } from 'esbuild';

// better-sqlite3 is an optionalDependency (native addon). The hub imports it
// statically in a module that is only reached lazily, but bundling hoists that
// import to the top of dist/bin.js, which would crash the whole CLI when the
// addon failed to install. Swap it for a shim that requires it on first use.
const lazyBetterSqlite3: Plugin = {
  name: 'lazy-better-sqlite3',
  setup(build) {
    build.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: 'better-sqlite3', namespace: 'lazy-sqlite' }));
    build.onLoad({ filter: /.*/, namespace: 'lazy-sqlite' }, () => ({
      loader: 'js',
      contents: [
        "import { createRequire } from 'node:module';",
        'const load = createRequire(import.meta.url);',
        'export default function Database(...args) { const Real = load("better-sqlite3"); return new Real(...args); }',
      ].join('\n'),
    }));
  },
};

// Single self-contained entry: dist/bin.js. paths.ts resolves the hook binary via
// new URL('./bin.js', import.meta.url), so no code-splitting chunks may be emitted.
export default defineConfig({
  entry: { bin: '../cli/src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  clean: true,
  noExternal: [/^@agentteams\//],
  external: ['cloudflared'],
  esbuildPlugins: [lazyBetterSqlite3],
});
