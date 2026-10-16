import { resolve } from 'node:path';
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

const AMBIGUOUS = 'agentteams hub did not respond in time; the call may or may not have completed';

function isAuthRejection(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; name?: string; message?: string };
  return err.code === 401 || err.name === 'UnauthorizedError' || /\bHTTP 401\b/.test(err.message ?? '');
}

const CONNECT_PHASE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

function errCode(e: unknown): unknown {
  return typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
}

/** HTTP-level failure from the SDK transport (carries the status as `code`). */
function httpStatus(e: unknown): number | undefined {
  const code = errCode(e);
  return e instanceof Error && e.message.startsWith('Streamable HTTP error') && typeof code === 'number' ? code : undefined;
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

/** A network failure that happens while connecting, before the hub could have seen the request. */
function isConnectPhaseError(e: unknown): boolean {
  const cause = typeof e === 'object' && e !== null ? (e as { cause?: unknown }).cause : undefined;
  return [errCode(e), errCode(cause)].some((c) => typeof c === 'string' && CONNECT_PHASE_CODES.has(c));
}

/** Retry-safe: a connect-phase network error, or a stale-session 404 (the hub did not run the call). Never 5xx or timeouts. */
function isRetryableCallError(e: unknown): boolean {
  if (isTimeout(e)) return false;
  const status = httpStatus(e);
  if (status !== undefined) return status === 404;
  return isConnectPhaseError(e);
}

/** A failed initial connect is retried once, unless it was a server error, a timeout or an auth rejection. */
function isRetryableConnectError(e: unknown): boolean {
  if (isTimeout(e) || isAuthRejection(e)) return false;
  const status = httpStatus(e);
  return status === undefined || status < 500;
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
    // Retry once only for connect-phase failures (ECONNREFUSED, ENOTFOUND, EAI_AGAIN, a stale
    // session 404, or the initial connect throwing). Never after ECONNRESET (it can follow a sent request), after an HTTP 5xx, a timeout or ConnectionClosed:
    // the hub may already have processed the call. Other McpErrors are genuine protocol/tool errors.
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      let client: Client;
      try {
        client = await getUpstream();
      } catch (e) {
        lastError = e;
        if (isRetryableConnectError(e)) continue;
        break;
      }
      try {
        return await client.callTool(req.params);
      } catch (e) {
        if (e instanceof McpError) {
          if (e.code !== ErrorCode.ConnectionClosed && e.code !== ErrorCode.RequestTimeout) {
            return errorResult(e.message);
          }
          drop();
          return errorResult(AMBIGUOUS);
        }
        drop();
        lastError = e;
        if (isRetryableCallError(e)) continue;
        return errorResult(isAuthRejection(e) ? AUTH_REJECTED : AMBIGUOUS);
      }
    }
    return errorResult(
      isAuthRejection(lastError) ? AUTH_REJECTED : `agentteams hub unreachable at ${opts.hubUrl} — is it running?`,
    );
  });
  server.onclose = () => drop();
  return server;
}

/** `repo` overrides the cwd used to find credentials (for configs whose process does not start in the repo). */
export async function runMcpProxy(deps: CliDeps, tool: ToolKind, opts: { repo?: string } = {}): Promise<void> {
  const cwd = opts.repo ? resolve(deps.cwd, opts.repo) : deps.cwd;
  const cred = await resolveCredentialForCwd(deps, cwd, tool);
  if (!cred) deps.err(`agentteams: no team credentials for ${cwd}`);
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
  const inflight = trackInflight(transport);
  await server.connect(transport);
  inflight.hook();
  // StdioServerTransport does not notice stdin ending; once it does, let in-flight requests
  // finish and their responses get written (bounded), then close so the process can exit.
  process.stdin.once('end', () => {
    void inflight.drain(DRAIN_TIMEOUT_MS).finally(() => server.close());
  });
  await closed;
}

const DRAIN_TIMEOUT_MS = 10_000;

type Transport = InstanceType<typeof import('@modelcontextprotocol/sdk/server/stdio.js').StdioServerTransport>;

/** Tracks JSON-RPC requests from receipt until their response has been written to the transport. */
function trackInflight(transport: Transport) {
  const ids = new Set<string | number>();
  let idle: (() => void) | null = null;
  const settle = (id: string | number) => {
    ids.delete(id);
    if (ids.size === 0) idle?.();
  };
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    try {
      await send(message);
    } finally {
      if ('id' in message && message.id !== undefined && !('method' in message)) settle(message.id);
    }
  };
  return {
    /** Must run after server.connect, which installs transport.onmessage. */
    hook() {
      const onmessage = transport.onmessage;
      transport.onmessage = (message) => {
        if ('id' in message && message.id !== undefined && 'method' in message) ids.add(message.id);
        onmessage?.(message);
      };
    },
    drain(timeoutMs: number): Promise<void> {
      if (ids.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        idle = () => { clearTimeout(timer); resolve(); };
      });
    },
  };
}
