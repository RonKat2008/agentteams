import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { openTeamStore } from './store.js';

/**
 * The team's MCP server for a local credential, in-process: the hub's own tool set over this repo's database.
 * Authenticates once (that also records presence) and again on every tool call, like the HTTP hub does per request.
 */
export async function createLocalMcpServer(deps: Pick<CliDeps, 'exec'>, cred: Credential): Promise<Server> {
  const store = await openTeamStore(deps, cred.repoPath);
  const actor = await store.core.authenticate(store.ctx, cred.apiKey);
  const server = store.core.buildMcpServer(store.ctx, actor).server;
  const heartbeat = () => { void store.core.authenticate(store.ctx, cred.apiKey).catch(() => undefined); };
  const connect = server.connect.bind(server);
  server.connect = async (transport) => {
    await connect(transport);
    const onmessage = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if ('method' in message && message.method === 'tools/call') heartbeat();
      onmessage?.(message, extra);
    };
  };
  return server;
}
