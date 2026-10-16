import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
  await hub.close().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

async function downstreamFor(upstream: Client | null) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await (await createProxyServer({ connect: upstream ? async () => upstream : null, hubUrl: hub.url })).connect(a);
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

  async function proxyTo(apiKey: string) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await (await createProxyServer({ connect: () => connectUpstream(hub.url, apiKey), hubUrl: hub.url })).connect(a);
    const downstream = new Client({ name: 'codex', version: '0' });
    await downstream.connect(b);
    return downstream;
  }
  const textOf = (r: { content?: unknown }) => (r.content as Array<{ text: string }>)[0]!.text;

  it('reconnects transparently when the hub restarts on the same port', async () => {
    const created = await new HubClient(hub.url).createTeam({ name: 's', member: 'ronit', tool: 'codex', repo: { provider: 'local' } });
    const port = Number(new URL(hub.url).port);
    const downstream = await proxyTo(created.apiKey);
    expect((await downstream.callTool({ name: 'team_status', arguments: {} })).isError).toBeFalsy();

    await hub.close();
    hub = await startHub({ dbPath: join(dir, 'hub.db'), port });
    const res = await downstream.callTool({ name: 'team_status', arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('ronit-codex');
    await downstream.close();
  });

  it('returns the unreachable error when the hub stays down after a successful call', async () => {
    const created = await new HubClient(hub.url).createTeam({ name: 's', member: 'ronit', tool: 'codex', repo: { provider: 'local' } });
    const downstream = await proxyTo(created.apiKey);
    expect((await downstream.callTool({ name: 'team_status', arguments: {} })).isError).toBeFalsy();

    await hub.close();
    const res = await downstream.callTool({ name: 'team_status', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(`agentteams hub unreachable at ${hub.url} — is it running?`);
    await downstream.close();
  });

  it('reports a rejected API key distinctly from an unreachable hub', async () => {
    const downstream = await proxyTo('bad-key');
    const res = await downstream.callTool({ name: 'team_status', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("agentteams hub rejected this agent's API key (re-run agentteams join or install)");
    await downstream.close();
  });

  it('never retries a call that timed out, since the hub may have processed it', async () => {
    const { McpError, ErrorCode } = await import('@modelcontextprotocol/sdk/types.js');
    let connects = 0;
    let calls = 0;
    const flaky = {
      callTool: async () => {
        calls++;
        throw new McpError(ErrorCode.RequestTimeout, 'Request timed out');
      },
      close: async () => undefined,
    } as unknown as Client;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await (await createProxyServer({ connect: async () => { connects++; return flaky; }, hubUrl: hub.url })).connect(a);
    const downstream = new Client({ name: 'codex', version: '0' });
    await downstream.connect(b);

    const res = await downstream.callTool({ name: 'send_message', arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('agentteams hub did not respond in time; the call may or may not have completed');
    expect(calls).toBe(1);
    expect(connects).toBe(1);
    await downstream.close();
  });

  it('treats ConnectionClosed on a sent call like a timeout (no retry)', async () => {
    const { McpError, ErrorCode } = await import('@modelcontextprotocol/sdk/types.js');
    let calls = 0;
    const closed = {
      callTool: async () => {
        calls++;
        throw new McpError(ErrorCode.ConnectionClosed, 'Connection closed');
      },
      close: async () => undefined,
    } as unknown as Client;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await (await createProxyServer({ connect: async () => closed, hubUrl: hub.url })).connect(a);
    const downstream = new Client({ name: 'codex', version: '0' });
    await downstream.connect(b);
    const res = await downstream.callTool({ name: 'send_message', arguments: {} });
    expect(textOf(res)).toContain('may or may not have completed');
    expect(calls).toBe(1);
    await downstream.close();
  });

  describe('retry narrowing', () => {
    async function proxyWith(connect: () => Promise<Client>) {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await (await createProxyServer({ connect, hubUrl: hub.url })).connect(a);
      const downstream = new Client({ name: 'codex', version: '0' });
      await downstream.connect(b);
      return downstream;
    }
    const okClient = (onCall: () => void) => ({
      callTool: async () => { onCall(); return { content: [{ type: 'text', text: 'fine' }] }; },
      close: async () => undefined,
    }) as unknown as Client;
    const netError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

    it.each(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'])('retries once after a %s network failure', async (code) => {
      let calls = 0;
      let connects = 0;
      const first = { callTool: async () => { calls++; throw netError(code); }, close: async () => undefined } as unknown as Client;
      const downstream = await proxyWith(async () => (++connects === 1 ? first : okClient(() => { calls++; })));
      const res = await downstream.callTool({ name: 'team_status', arguments: {} });
      expect(textOf(res)).toBe('fine');
      expect(calls).toBe(2);
      await downstream.close();
    });

    it('never retries after an HTTP 5xx StreamableHTTPError', async () => {
      let calls = 0;
      const c = { callTool: async () => { calls++; throw new StreamableHTTPError(503, 'Service Unavailable'); }, close: async () => undefined } as unknown as Client;
      const downstream = await proxyWith(async () => c);
      const res = await downstream.callTool({ name: 'send_message', arguments: {} });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('may or may not have completed');
      expect(calls).toBe(1);
      await downstream.close();
    });

    it('never retries an unclassified error from a sent call', async () => {
      let calls = 0;
      const c = { callTool: async () => { calls++; throw new Error('boom'); }, close: async () => undefined } as unknown as Client;
      const downstream = await proxyWith(async () => c);
      const res = await downstream.callTool({ name: 'send_message', arguments: {} });
      expect(res.isError).toBe(true);
      expect(calls).toBe(1);
      await downstream.close();
    });

    it('retries once when the initial connect throws', async () => {
      let connects = 0;
      let calls = 0;
      const downstream = await proxyWith(async () => {
        if (++connects === 1) throw netError('ECONNREFUSED');
        return okClient(() => { calls++; });
      });
      expect(textOf(await downstream.callTool({ name: 'team_status', arguments: {} }))).toBe('fine');
      expect(connects).toBe(2);
      expect(calls).toBe(1);
      await downstream.close();
    });

    it('does not retry a connect that fails with an HTTP 5xx', async () => {
      let connects = 0;
      const downstream = await proxyWith(async () => { connects++; throw new StreamableHTTPError(502, 'Bad Gateway'); });
      const res = await downstream.callTool({ name: 'team_status', arguments: {} });
      expect(res.isError).toBe(true);
      expect(connects).toBe(1);
      await downstream.close();
    });
  });
});
