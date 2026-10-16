import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolKind } from '@agentteams/shared';
import { resolveCredentialForCwd } from './credentials.js';
import type { CliDeps } from './deps.js';

const errorResult = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

export async function connectUpstream(hubUrl: string, apiKey: string): Promise<Client> {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  const client = new Client({ name: 'agentteams-proxy', version: '0.1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${hubUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
    }),
  );
  return client;
}

let cachedStaticTools: Promise<Tool[]> | null = null;
function staticTools(): Promise<Tool[]> {
  cachedStaticTools ??= import('@agentteams/hub').then(({ listToolDefinitions }) => listToolDefinitions());
  return cachedStaticTools;
}

const AUTH_REJECTED = "agentteams hub rejected this agent's API key (re-run agentteams join or install)";

function isAuthRejection(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; name?: string; message?: string };
  return err.code === 401 || err.name === 'UnauthorizedError' || /\bHTTP 401\b/.test(err.message ?? '');
}

export interface ProxyOptions {
  /** Opens a connection to the hub; null when this directory has no credentials. */
  connect: (() => Promise<Client>) | null;
  hubUrl?: string;
  /** Tool list served while the hub is unreachable. Defaults to the hub package's definitions. */
  tools?: () => Promise<Tool[]>;
}

export async function createProxyServer(opts: ProxyOptions) {
  const [{ Server }, { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  const server = new Server({ name: 'agentteams', version: '0.1.0' }, { capabilities: { tools: {} } });
  let upstream: Client | null = null;
  let pending: Promise<Client> | null = null;
  const getUpstream = (): Promise<Client> => {
    if (upstream) return Promise.resolve(upstream);
    pending ??= opts.connect!().then(
      (c) => { upstream = c; pending = null; return c; },
      (e) => { pending = null; throw e; },
    );
    return pending;
  };
  const drop = () => {
    const old = upstream;
    upstream = null;
    void old?.close().catch(() => undefined);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!opts.connect) return { tools: [] };
    try {
      return await (await getUpstream()).listTools();
    } catch {
      drop();
      return { tools: await (opts.tools ?? staticTools)() };
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (!opts.connect) return errorResult('agentteams: no team credentials for this directory');
    // Transport-level McpErrors mean the client is dead; anything else is a genuine protocol/tool error.
    const isDeadClient = (e: unknown) =>
      !(e instanceof McpError) || e.code === ErrorCode.ConnectionClosed || e.code === ErrorCode.RequestTimeout;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await (await getUpstream()).callTool(req.params);
      } catch (e) {
        if (!isDeadClient(e)) return errorResult((e as Error).message);
        drop();
        lastError = e;
      }
    }
    return errorResult(
      isAuthRejection(lastError) ? AUTH_REJECTED : `agentteams hub unreachable at ${opts.hubUrl} — is it running?`,
    );
  });
  server.onclose = () => drop();
  return server;
}

export async function runMcpProxy(deps: CliDeps, tool: ToolKind): Promise<void> {
  const cred = await resolveCredentialForCwd(deps, deps.cwd, tool);
  if (!cred) deps.err(`agentteams: no team credentials for ${deps.cwd}`);
  const server = await createProxyServer({
    connect: cred ? () => connectUpstream(cred.hubUrl, cred.apiKey) : null,
    hubUrl: cred?.hubUrl,
  });
  const closed = new Promise<void>((resolve) => {
    const prev = server.onclose;
    server.onclose = () => {
      prev?.();
      resolve();
    };
  });
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const transport = new StdioServerTransport();
  // StdioServerTransport does not notice stdin ending; close explicitly so the process can exit.
  process.stdin.once('end', () => void server.close());
  await server.connect(transport);
  await closed;
}
