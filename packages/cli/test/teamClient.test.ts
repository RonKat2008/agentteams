import { describe, expect, it } from 'vitest';
import type { Credential } from '../src/credentials.js';
import { HubClient } from '../src/hubClient.js';
import { realExec } from '../src/deps.js';
import { teamClientFor } from '../src/teamClient.js';

const cred = (over: Partial<Credential> = {}): Credential => ({
  repoPath: '/work/app', tool: 'claude', hubUrl: 'http://127.0.0.1:1', teamName: 't',
  agentName: 'a', apiKey: 'at_k', createdAt: '2026-01-01T00:00:00.000Z', ...over,
});

describe('teamClientFor', () => {
  it('returns an HTTP HubClient when transport is undefined or http', () => {
    const deps = { fetch: (async () => new Response('{}')) as unknown as typeof fetch, exec: realExec };
    expect(teamClientFor(deps, cred())).toBeInstanceOf(HubClient);
    expect(teamClientFor(deps, cred({ transport: 'http' }))).toBeInstanceOf(HubClient);
  });

  it('uses the injected fetch, the api key and the timeout', async () => {
    let seen: { url: string; auth: string | undefined; signal: AbortSignal | undefined } | undefined;
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).authorization, signal: init.signal ?? undefined };
      return new Response(JSON.stringify({ orchestrator: 'a' }), { status: 200 });
    }) as unknown as typeof fetch;
    await teamClientFor({ fetch: fetchStub, exec: realExec }, cred(), { timeoutMs: 2000 }).setOrchestrator('a');
    expect(seen).toMatchObject({ url: 'http://127.0.0.1:1/api/team/orchestrator', auth: 'Bearer at_k' });
    expect(seen?.signal).toBeDefined();
  });

  it('rejects the git transport until it is implemented', () => {
    const deps = { fetch: globalThis.fetch, exec: realExec };
    expect(() => teamClientFor(deps, cred({ transport: 'git' }))).toThrow('transport not supported yet');
  });
});
