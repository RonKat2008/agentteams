import { defineConfig } from 'tsup';
import type { Plugin } from 'esbuild';

// better-sqlite3 is a native addon, needed by local and git teams (the default). The hub imports it
// statically in a module that is only reached lazily, but bundling hoists that import to the top of
// dist/bin.js, which would crash every command (hub teams included) if the addon failed to build.
// Swap it for a shim that requires it on first use and explains a failed load.
const lazyBetterSqlite3: Plugin = {
  name: 'lazy-better-sqlite3',
  setup(build) {
    build.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: 'better-sqlite3', namespace: 'lazy-sqlite' }));
    build.onLoad({ filter: /.*/, namespace: 'lazy-sqlite' }, () => ({
      loader: 'js',
      contents: [
        "import { createRequire } from 'node:module';",
        'const load = createRequire(import.meta.url);',
        'function real() {',
        '  try { return load("better-sqlite3"); } catch (err) {',
        '    throw new Error("agentteams: the better-sqlite3 native module could not be loaded (" + (err && err.message ? err.message.split("\\n")[0] : err) + "). " +',
        '      "Local and git teams need it: reinstall with `npm i -g agentteams-cli` where a C++ build toolchain is available, " +',
        '      "or use a hub team (--hub).", { cause: err });',
        '  }',
        '}',
        'export default function Database(...args) { const Real = real(); return new Real(...args); }',
      ].join('\n'),
    }));
  },
};

// Entry stays dist/bin.js (hook commands point at it). Splitting keeps the hub (pg, hono, MCP SDK)
// in lazily loaded chunks so `hook` invocations do not pay for them. Chunks land flat next to bin.js,
// so paths.ts' new URL('./bin.js', import.meta.url) still resolves to dist/bin.js from any chunk.
export default defineConfig({
  entry: { bin: '../cli/src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: true,
  clean: true,
  // better-sqlite3 is a dependency, which tsup would leave as a plain import: route it through the shim instead.
  noExternal: [/^@agentteams\//, 'better-sqlite3'],
  external: ['cloudflared'],
  esbuildPlugins: [lazyBetterSqlite3],
});
