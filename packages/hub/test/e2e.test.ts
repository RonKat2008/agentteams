import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHub } from '../src/server.js';

let dir: string;
let hub: Awaited<ReturnType<typeof startHub>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentteams-e2e-'));
  hub = await startHub({ dbPath: join(dir, 'hub.db'), port: 0 });
});
afterEach(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = async (path: string, body: unknown) =>
  (await fetch(`${hub.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

describe('hub over real HTTP', () => {
  it('lets four agents from three people coordinate through MCP', async () => {
    expect(hub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const ronit = await post('/api/teams', { name: 'dev-squad', member: 'ronit', tool: 'claude', repo: { provider: 'github', slug: 'ronit/my-app' } });
    const ronitCodex = await post('/api/join', { inviteCode: ronit.inviteCode, member: 'ronit', tool: 'codex' });
    const dylan = await post('/api/join', { inviteCode: ronit.inviteCode, member: 'dylan', tool: 'claude' });
    const ash = await post('/api/join', { inviteCode: ronit.inviteCode, member: 'ash', tool: 'codex' });
    expect([ronitCodex.agentName, dylan.agentName, ash.agentName]).toEqual(['ronit-codex', 'dylan-claude', 'ash-codex']);

    const mcp = async (apiKey: string) => {
      const client = new Client({ name: 'e2e', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${hub.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
      }));
      return client;
    };
    const orch = await mcp(ronit.apiKey);
    const worker = await mcp(ash.apiKey);
    try {
      await orch.callTool({ name: 'create_task', arguments: { title: 'Login page', assignee: 'ash-codex' } });
      const inbox = await worker.callTool({ name: 'read_inbox', arguments: {} });
      expect((inbox.content as Array<{ text: string }>)[0]!.text).toContain('Task #1');

      const commit = await fetch(`${hub.url}/api/team/commits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ash.apiKey}` },
        body: JSON.stringify({ sha: 'abc1234', branch: 'at/ash-codex/1', message: 'Add login', files: ['src/login.ts'], insertions: 10, deletions: 0 }),
      });
      expect(commit.status).toBe(200);

      const changes = await orch.callTool({ name: 'get_changes', arguments: {} });
      expect((changes.content as Array<{ text: string }>)[0]!.text).toContain('abc1234');
    } finally {
      await orch.close();
      await worker.close();
    }
  });

  it('persists data across restarts', async () => {
    const created = await post('/api/teams', { name: 'keep', member: 'ronit', tool: 'claude', repo: { provider: 'local' } });
    await hub.close();
    hub = await startHub({ dbPath: join(dir, 'hub.db'), port: 0 });
    const res = await fetch(`${hub.url}/api/team/status`, { headers: { authorization: `Bearer ${created.apiKey}` } });
    expect((await res.json()).team.name).toBe('keep');
  });

  it('rejects and releases its database when the port is taken', async () => {
    const port = Number(new URL(hub.url).port);
    await expect(startHub({ dbPath: join(dir, 'second.db'), port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
