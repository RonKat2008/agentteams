import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Actor, HubContext } from '../context.js';
import { DomainError, type ErrorCode } from '../errors.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildMcpServer } from '../mcp/server.js';
import { getActivity } from '../services/activity.js';
import { whoOwns } from '../services/claims.js';
import { getChanges, recordCommit } from '../services/commits.js';
import { readInbox } from '../services/messages.js';
import { listTasks } from '../services/tasks.js';
import {
  authenticate, createTeam, getTeamStatus, joinTeam, revokeInvite, rotateInvite, setOrchestrator,
} from '../services/teams.js';

export type AppEnv = { Variables: { actor: Actor } };

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, invalid: 400,
};

async function body(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DomainError('invalid', 'request body must be valid JSON');
  }
}

export function requireAgent(ctx: HubContext) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    if (!match) throw new DomainError('unauthorized', 'missing bearer API key');
    c.set('actor', await authenticate(ctx, match[1]!));
    await next();
  });
}

export function createApp(ctx: HubContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: { code: err.code, message: err.message } }, STATUS[err.code]);
    console.error('[agentteams-hub] unhandled error', err);
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));
  app.post('/api/teams', async (c) => c.json(await createTeam(ctx, (await body(c)) as never), 201));
  app.post('/api/join', async (c) => c.json(await joinTeam(ctx, (await body(c)) as never), 201));

  app.use('/api/team/*', requireAgent(ctx));
  app.post('/api/team/ping', async (c) => {
    const actor = c.get('actor');
    return c.json({ agent: actor.name, messages: await readInbox(ctx, actor, (await body(c)) as never) });
  });
  app.get('/api/team/status', async (c) => c.json(await getTeamStatus(ctx, c.get('actor'))));
  app.get('/api/team/activity', async (c) => c.json(await getActivity(ctx, c.get('actor'), c.req.query())));
  app.get('/api/team/tasks', async (c) => c.json(await listTasks(ctx, c.get('actor'), c.req.query() as never)));
  app.get('/api/team/changes', async (c) => c.json(await getChanges(ctx, c.get('actor'), c.req.query())));
  app.post('/api/team/commits', async (c) => c.json(await recordCommit(ctx, c.get('actor'), (await body(c)) as never)));
  app.get('/api/team/who-owns', async (c) => c.json(await whoOwns(ctx, c.get('actor'), { path: c.req.query('path') ?? '' })));
  app.post('/api/team/orchestrator', async (c) => c.json(await setOrchestrator(ctx, c.get('actor'), (await body(c)) as never)));
  app.post('/api/team/invite/rotate', async (c) => c.json(await rotateInvite(ctx, c.get('actor'))));
  app.post('/api/team/invite/revoke', async (c) => c.json(await revokeInvite(ctx, c.get('actor'))));

  app.use('/mcp', requireAgent(ctx));
  app.all('/mcp', async (c) => {
    const server = buildMcpServer(ctx, c.get('actor'));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}
