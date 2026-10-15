import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolKind } from '@agentteams/shared';
import { resolveCredential } from './credentials.js';
import type { CliDeps } from './deps.js';

const errorResult = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

export function createProxyServer(upstream: Client | null, hubUrl?: string): Server {
  const server = new Server({ name: 'agentteams', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!upstream) return { tools: [] };
    try {
      return await upstream.listTools();
    } catch {
      return { tools: [] };
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (!upstream) return errorResult('agentteams: no team credentials for this directory');
    try {
      return await upstream.callTool(req.params);
    } catch {
      return errorResult(`agentteams hub unreachable at ${hubUrl}`);
    }
  });
  return server;
}

export async function runMcpProxy(deps: CliDeps, tool: ToolKind): Promise<void> {
  const cred = await resolveCredential(deps, deps.cwd, tool);
  let upstream: Client | null = null;
  if (!cred) {
    deps.err(`agentteams: no team credentials for ${deps.cwd}`);
  } else {
    const client = new Client({ name: 'agentteams-proxy', version: '0.1.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${cred.hubUrl}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${cred.apiKey}` } },
        }),
      );
      upstream = client;
    } catch {
      deps.err(`agentteams: hub unreachable at ${cred.hubUrl}`);
    }
  }
  await createProxyServer(upstream, cred?.hubUrl).connect(new StdioServerTransport());
}
