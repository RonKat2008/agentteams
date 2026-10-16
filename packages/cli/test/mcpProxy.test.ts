import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startHub } from '@agentteams/hub';
import { HubClient } from '../src/hubClient.js';
import { connectUpstream, createProxyServer } from '../src/mcpProxy.js';

let dir: string;
let hub: Awaited<ReturnType<typeof startHub>>;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentteams-proxy-'));
  hub = await startHub({ dbPath: join(dir, 'hub.db'), port: 0 });
});
afterEach(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function downstreamFor(upstream: Client | null, reason?: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await (await createProxyServer({ connect: upstream ? async () => upstream : null, hubUrl: hub.url, reason })).connect(a);
  const downstream = new Client({ name: 'codex', version: '0' });
  await downstream.connect(b);
  return downstream;
}

describe('MCP proxy', () => {
  it('forwards tools/list and tools/call to the hub as the credential owner', async () => {
    const created = await new HubClient(hub.url).createTeam({ name: 's', member: 'ronit', tool: 'codex', repo: { provider: 'local' } });
    const upstream = new Client({ name: 'proxy', version: '0' });
    await upstream.connect(new StreamableHTTPClientTransport(new URL(`${hub.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${created.apiKey}` } } }));
    const downstream = await downstreamFor(upstream);

    const tools = (await downstream.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('team_status');
    expect(tools).toHaveLength(15);
    const res = await downstream.callTool({ name: 'team_status', arguments: {} });
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('ronit-codex');

    await downstream.close();
    await upstream.close();
  });

  it('serves an empty tool list without credentials', async () => {
    const downstream = await downstreamFor(null);
    expect((await downstream.listTools()).tools).toEqual([]);
    await downstream.close();
  });

  it('reports the distinct reason on calls when credentials exist but the hub is unreachable', async () => {
    const downstream = await downstreamFor(null, 'agentteams hub unreachable at http://x');
    const res = await downstream.callTool({ name: 'team_status', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toBe('agentteams hub unreachable at http://x');
    await downstream.close();
  });

  it('reports missing credentials by default', async () => {
    const downstream = await downstreamFor(null);
    const res = await downstream.callTool({ name: 'team_status', arguments: {} });
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain('no team credentials');
    await downstream.close();
  });

  it('serves the full tool list offline and connects lazily once the hub starts', async () => {
    const created = await new HubClient(hub.url).createTeam({ name: 's', member: 'ronit', tool: 'codex', repo: { provider: 'local' } });
    const port = Number(new URL(hub.url).port);
    await hub.close();

    const [a, b] = InMemoryTransport.createLinkedPair();
    await (await createProxyServer({ connect: () => connectUpstream(hub.url, created.apiKey), hubUrl: hub.url })).connect(a);
    const downstream = new Client({ name: 'codex', version: '0' });
    await downstream.connect(b);

    const offline = await downstream.listTools();
    expect(offline.tools).toHaveLength(15);
    expect(offline.tools.find((t) => t.name === 'send_message')?.inputSchema.properties).toBeDefined();
    const down = await downstream.callTool({ name: 'team_status', arguments: {} });
    expect(down.isError).toBe(true);
    expect((down.content as Array<{ text: string }>)[0]!.text).toBe(`agentteams hub unreachable at ${hub.url} — is it running?`);

    hub = await startHub({ dbPath: join(dir, 'hub.db'), port });
    const up = await downstream.callTool({ name: 'team_status', arguments: {} });
    expect(up.isError).toBeFalsy();
    expect((up.content as Array<{ text: string }>)[0]!.text).toContain('ronit-codex');
    expect((await downstream.listTools()).tools).toHaveLength(15);
    await downstream.close();
  });
});
