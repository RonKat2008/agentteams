import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHub } from '@agentteams/hub';
import { HubClient, HubError } from '../src/hubClient.js';

let dir: string;
let hub: Awaited<ReturnType<typeof startHub>>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentteams-client-'));
  hub = await startHub({ dbPath: join(dir, 'hub.db'), port: 0 });
});
afterEach(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('HubClient', () => {
  it('creates, joins, pings and reads status', async () => {
    const anon = new HubClient(hub.url);
    const created = await anon.createTeam({ name: 'dev-squad', member: 'ronit', tool: 'claude', repo: { provider: 'local' } });
    const joined = await anon.joinTeam({ inviteCode: created.inviteCode, member: 'ash', tool: 'codex' });
    expect(joined.agentName).toBe('ash-codex');

    const ronit = new HubClient(hub.url, { apiKey: created.apiKey });
    const ash = new HubClient(hub.url, { apiKey: joined.apiKey });
    expect((await ronit.status()).team.orchestrator).toBe('ronit-claude');
    expect(await ash.ping()).toEqual({ agent: 'ash-codex', messages: [] });
    expect((await ronit.activity({ limit: 1 }))[0]!.type).toBe('agent_joined');
    expect((await ronit.rotateInvite()).inviteCode).not.toBe(created.inviteCode);
  });

  it('maps hub error bodies to HubError', async () => {
    const bad = new HubClient(hub.url, { apiKey: 'at_nope' });
    await expect(bad.status()).rejects.toMatchObject({ name: 'HubError', code: 'unauthorized', status: 401 });
  });

  it('reports an unreachable hub quickly', async () => {
    const deadUrl = hub.url;
    await hub.close();
    hub = await startHub({ dbPath: join(dir, 'hub2.db'), port: 0 }); // keeps afterEach valid; deadUrl stays dead
    const started = Date.now();
    const err = await new HubClient(deadUrl, { timeoutMs: 500 }).status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubError);
    expect((err as HubError).code).toBe('unreachable');
    expect((err as HubError).message).toContain('agentteams up');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
