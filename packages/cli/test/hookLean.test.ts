import { describe, expect, it, vi } from 'vitest';
import { makeTestCli } from './helpers.js';

// If the hook path ever evaluates these modules, the factory throws and the import (or the hook) fails.
vi.mock('@agentteams/hub', () => { throw new Error('hub must not load on the hook path'); });
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => { throw new Error('MCP SDK must not load on the hook path'); });
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => { throw new Error('MCP SDK must not load on the hook path'); });

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
});
