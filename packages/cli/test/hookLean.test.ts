import { describe, expect, it, vi } from 'vitest';
import { saveCredential } from '../src/credentials.js';
import { runHook } from '../src/hooks.js';
import { makeTestCli } from './helpers.js';

// If the hook path ever evaluates these modules, the factory throws and the import (or the hook) fails.
vi.mock('@agentteams/hub', () => { throw new Error('hub must not load on the hook path'); });
vi.mock('@agentteams/hub/core', () => { throw new Error('hub core must not load for HTTP credentials'); });
vi.mock('better-sqlite3', () => { throw new Error('SQLite must not load for HTTP credentials'); });
vi.mock('kysely', () => { throw new Error('kysely must not load for HTTP credentials'); });
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => { throw new Error('MCP SDK must not load on the hook path'); });
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => { throw new Error('MCP SDK must not load on the hook path'); });
vi.mock('@clack/prompts', () => { throw new Error('the guided menu must not load on the hook path'); });

describe('hook path stays lean', () => {
  it('runs a hook without loading @agentteams/hub or the MCP SDK', async () => {
    const { main } = await import('../src/main.js');
    const t = makeTestCli();
    try {
      const code = await main(['node', 'agentteams', 'hook', 'session-start', '--tool', 'claude'], t.deps);
      expect(t.err).toEqual([]);
      expect(code).toBe(0);
    } finally {
      t.cleanup();
    }
  });

  it('an HTTP-credential hook round runs end to end without SQLite, kysely or hub core', async () => {
    const t = makeTestCli({
      fetch: (async (url: string) => {
        const body = String(url).endsWith('/status')
          ? { team: { name: 'Acme', repo: { provider: 'local', defaultBranch: 'main' }, orchestrator: 'ash-codex' }, agents: [] }
          : { agent: 'ash-codex', messages: [] };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch,
    });
    try {
      const repo = t.deps.cwd;
      await saveCredential(t.deps, {
        repoPath: repo, tool: 'codex', hubUrl: 'http://127.0.0.1:1', teamName: 'Acme', agentName: 'ash-codex',
        apiKey: 'at_k', createdAt: '2026-01-01T00:00:00.000Z',
      });
      const res = await runHook('session-start', JSON.stringify({ cwd: repo }), 'codex', t.deps);
      expect(res.stdout).toContain('Acme');
    } finally {
      t.cleanup();
    }
  });
});
