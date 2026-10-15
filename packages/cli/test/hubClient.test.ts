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

describe('HubClient git-layer methods', () => {
  it('previews, checks, overrides, runs the task lifecycle and records commits', async () => {
    const anon = new HubClient(hub.url);
    const created = await anon.createTeam({ name: 'dev-squad', member: 'ronit', tool: 'claude', repo: { provider: 'local' } });
    expect(await anon.previewInvite(created.inviteCode)).toMatchObject({ teamName: 'dev-squad' });
    const joined = await anon.joinTeam({ inviteCode: created.inviteCode, member: 'ash', tool: 'codex' });
    const ronit = new HubClient(hub.url, { apiKey: created.apiKey });
    const ash = new HubClient(hub.url, { apiKey: joined.apiKey });

    expect(await ash.checkFiles(['src/a.ts'])).toHaveProperty('conflicts');
    expect(await ash.claimOverride(['src/a.ts'])).toHaveProperty('owners');

    const commit = { sha: 'abc1234', branch: 'at/ash-codex/1', message: 'm', files: ['src/a.ts'], insertions: 1, deletions: 0 };
    expect(await ash.recordCommit(commit)).toMatchObject({ duplicate: false });
    expect(await ash.recordCommit(commit)).toEqual({ notified: [], duplicate: true });

    const rpc = await fetch(`${hub.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${created.apiKey}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { title: 'Login', assignee: 'ash-codex' } } }),
    });
    expect(rpc.status).toBe(200);
    expect((await ash.claimTask(1)).status).toBe('in_progress');
    expect((await ash.completeTask(1, 'built', 'at/ash-codex/1')).status).toBe('done');
    expect((await ash.getTask(1)).number).toBe(1);
    await expect(ash.markMerged(1)).rejects.toMatchObject({ status: 403 });
    expect((await ronit.markMerged(1, 'https://github.com/o/r/pull/1')).mergedAt).toBeTruthy();

    await expect(ash.getTask(7)).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
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

  describe('response handling (stubbed fetch)', () => {
    const stub = (res: () => Response) => new HubClient('http://127.0.0.1:1', { fetch: (async () => res()) as unknown as typeof fetch });

    it('maps a body stream failure to unreachable', async () => {
      const c = stub(() => new Response(new ReadableStream({ start(ctl) { ctl.error(new Error('reset')); } }), { status: 200 }));
      await expect(c.status()).rejects.toMatchObject({ name: 'HubError', code: 'unreachable', status: 0 });
    });

    it('maps a non-JSON error body to internal', async () => {
      const c = stub(() => new Response('<html>bad gateway</html>', { status: 502 }));
      await expect(c.status()).rejects.toMatchObject({ code: 'internal', status: 502, message: 'hub returned HTTP 502' });
    });

    it('rejects an empty 2xx body as internal', async () => {
      const c = stub(() => new Response('', { status: 200 }));
      await expect(c.status()).rejects.toMatchObject({ code: 'internal', status: 200 });
    });
  });
});
