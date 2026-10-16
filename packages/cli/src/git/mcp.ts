import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { HubError } from '../hubClient.js';
import { GitTeamClient, type GitClientOptions } from './client.js';
import type { OpInput, RegularOpName } from './ops.js';
import { openGitView, requireActor } from './view.js';

/**
 * The team's MCP server for a git credential, in-process. It is the hub's own server (same tools, schemas and
 * descriptions) over this repo's view, with every state-changing service swapped for the GitTeamClient write
 * path: the call is captured as an op, applied locally and pushed by a detached sync. read_inbox peeks without
 * side effects and marks read through a `markRead` op. Read-only tools call the services directly on the view.
 */
export async function createGitMcpServer(deps: Pick<CliDeps, 'exec'>, cred: Credential, opts: GitClientOptions = {}): Promise<Server> {
  const view = await openGitView(deps, cred);
  const actor = await requireActor(view);
  const { core } = view.store;
  const client = new GitTeamClient(deps, cred, opts);

  /** HubError -> DomainError, so the hub's tool wrapper reports `code: message` like any service error. */
  const domain = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof HubError && err.code !== 'internal') throw new core.DomainError(err.code as never, err.message);
      throw err;
    }
  };
  const op = <N extends RegularOpName>(name: N) =>
    (_ctx: unknown, _actor: unknown, input: unknown) => domain(() => client.execute(name, input as OpInput<N>)) as Promise<never>;

  const server = core.buildMcpServer(view.store.ctx, actor, {
    sendMessage: op('sendMessage'),
    createTask: op('createTask'),
    assignTask: op('assignTask'),
    claimTask: op('claimTask'),
    updateTask: op('updateTask'),
    completeTask: op('completeTask'),
    markMerged: op('markMerged'),
    claimFiles: op('claimFiles'),
    releaseFiles: op('releaseFiles'),
    readInbox: (_ctx, _actor, input) => domain(async () => (await client.inbox(input ?? {})).messages),
  }).server;

  const connect = server.connect.bind(server);
  server.connect = async (transport) => {
    await connect(transport);
    const onmessage = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if ('method' in message && message.method === 'tools/call') void client.touch();
      onmessage?.(message, extra);
    };
  };
  return server;
}
