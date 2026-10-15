import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolKind } from '@agentteams/shared';
import { resolveCredentialForCwd } from './credentials.js';
import type { CliDeps } from './deps.js';

const errorResult = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

export function createProxyServer(upstream: Client | null, hubUrl?: string, unavailableReason?: string): Server {
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
    if (!upstream) return errorResult(unavailableReason ?? 'agentteams: no team credentials for this directory');
    try {
      return await upstream.callTool(req.params);
    } catch {
      return errorResult(`agentteams hub unreachable at ${hubUrl}`);
    }
  });
  server.onclose = () => void upstream?.close();
  return server;
}

export async function runMcpProxy(deps: CliDeps, tool: ToolKind): Promise<void> {
  const cred = await resolveCredentialForCwd(deps, deps.cwd, tool);
  let upstream: Client | null = null;
  let reason: string | undefined;
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
      reason = `agentteams hub unreachable at ${cred.hubUrl}`;
    }
  }
  const server = createProxyServer(upstream, cred?.hubUrl, reason);
  const closed = new Promise<void>((resolve) => {
    const prev = server.onclose;
    server.onclose = () => {
      prev?.();
      resolve();
    };
  });
  const transport = new StdioServerTransport();
  // StdioServerTransport does not notice stdin ending; close explicitly so the process can exit.
  process.stdin.once('end', () => void server.close());
  await server.connect(transport);
  await closed;
}
