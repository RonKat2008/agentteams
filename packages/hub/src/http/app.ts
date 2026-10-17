import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Actor, HubContext } from '../context.js';
import { DomainError, type ErrorCode } from '../errors.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { clientIp, createTokenBucket, type IpSource } from './limits.js';
import { buildMcpServer } from '../mcp/server.js';
import { getActivity } from '../services/activity.js';
import { checkFiles, recordClaimOverride, whoOwns } from '../services/claims.js';
import { getChanges, recordCommit } from '../services/commits.js';
import { readInbox, sendMessage } from '../services/messages.js';
import { claimTask, completeTask, getTaskView, listTasks, markMerged } from '../services/tasks.js';
import {
  authenticate, createTeam, getTeamStatus, joinTeam, previewInvite, revokeInvite, rotateInvite, setOrchestrator,
} from '../services/teams.js';

export type AppEnv = { Variables: { actor: Actor } };

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, invalid: 400, rate_limited: 429,
};

function taskNumber(c: Context): number {
  const raw = c.req.param('n') ?? '';
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw new DomainError('invalid', 'task number must be a positive integer');
  return n;
}

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

export interface AppOptions {
  /** When set, requests whose Host hostname is not listed are refused (DNS-rebinding/CSRF guard for the local hub). */
  allowedHosts?: string[];
  /** 'hosted' trusts proxy client-IP headers and is reported on /health. Default 'local'. */
  mode?: 'local' | 'hosted';
  /** Trusted client-IP source in hosted mode. Default 'socket'. */
  ipSource?: IpSource;
  /** Per-minute budgets: per authenticated agent, and per client IP on the unauthenticated routes. */
  rateLimits?: { agentPerMin: number; ipPerMin: number };
  /** Clock for the rate limiters (ms); injectable so tests need not sleep. */
  now?: () => number;
}

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_RATE_LIMITS = { agentPerMin: 300, ipPerMin: 10 };
const WWW_AUTHENTICATE = 'Bearer realm="agentteams"';

class AuthPassed extends Error {}

function hostnameOf(host: string): string {
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1).toLowerCase();
  return host.split(':')[0]!.toLowerCase();
}

export function createApp(ctx: HubContext, opts: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const mode = opts.mode ?? 'local';
  const ipSource = opts.ipSource ?? 'socket';
  const now = opts.now ?? Date.now;
  // Local mode is one user on loopback: every client shares the socket IP and test/CLI traffic is bursty,
  // so limits are on by default only when hosted (or when explicitly configured).
  const limits = opts.rateLimits ?? (mode === 'hosted' ? DEFAULT_RATE_LIMITS : undefined);
  const ipBucket = limits ? createTokenBucket(limits.ipPerMin, now) : undefined;
  const agentBucket = limits ? createTokenBucket(limits.agentPerMin, now) : undefined;
  // Hook pings are frequent and automatic; a separate bucket keeps them from starving MCP/tool calls.
  const pingBucket = limits ? createTokenBucket(limits.agentPerMin, now) : undefined;

  const limited = (c: Context, retryAfterSec: number) => {
    c.header('Retry-After', String(retryAfterSec));
    return c.json({ error: { code: 'rate_limited', message: `too many requests; retry in ${retryAfterSec}s` } }, 429);
  };

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      if (err.code === 'unauthorized') c.header('WWW-Authenticate', WWW_AUTHENTICATE);
      return c.json({ error: { code: err.code, message: err.message } }, STATUS[err.code]);
    }
    console.error('[agentteams-hub] unhandled error', err);
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'route not found' } }, 404));

  // Registered before the Host allowlist: platform health checks hit the machine with an internal Host.
  app.get('/health', (c) => c.json({ ok: true, mode }));

  if (opts.allowedHosts) {
    const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
    app.use('*', async (c, next) => {
      const host = hostnameOf(c.req.header('host') ?? new URL(c.req.url).host);
      if (!allowed.has(host)) throw new DomainError('forbidden', 'host not allowed');
      await next();
    });
  }

  const tooLarge = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: { code: 'invalid', message: 'request body too large' } }, 413),
  });
  app.use('/api/*', tooLarge);
  app.use('/mcp', tooLarge);

  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'POST') {
      const length = c.req.header('content-length');
      const hasBody = (length !== undefined && length !== '0') || c.req.header('transfer-encoding') !== undefined;
      const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (hasBody && type !== 'application/json') {
        return c.json({ error: { code: 'invalid', message: 'Content-Type must be application/json' } }, 415);
      }
    }
    await next();
  });

  const ipLimit = createMiddleware<AppEnv>(async (c, next) => {
    const r = ipBucket?.take(clientIp(c, mode, ipSource));
    if (r && !r.ok) return limited(c, r.retryAfterSec);
    await next();
  });
  app.use('/api/teams', ipLimit);
  app.use('/api/join', ipLimit);
  app.use('/api/join/preview', ipLimit);

  app.post('/api/teams', async (c) => c.json(await createTeam(ctx, (await body(c)) as never), 201));
  app.post('/api/join', async (c) => c.json(await joinTeam(ctx, (await body(c)) as never), 201));

  app.post('/api/join/preview', async (c) => c.json(await previewInvite(ctx, (await body(c)) as never)));

  const agentLimit = createMiddleware<AppEnv>(async (c, next) => {
    const bucket = c.req.method === 'POST' && c.req.path === '/api/team/ping' ? pingBucket : agentBucket;
    const r = bucket?.take(c.get('actor').id);
    if (r && !r.ok) return limited(c, r.retryAfterSec);
    await next();
  });

  // Failed auth spends an IP token so API-key guessing is throttled like the other unauthenticated routes.
  const authenticated = createMiddleware<AppEnv>(async (c, next) => {
    try {
      await requireAgent(ctx)(c, async () => {
        throw new AuthPassed();
      });
    } catch (err) {
      if (!(err instanceof AuthPassed)) {
        const r = err instanceof DomainError && err.code === 'unauthorized' ? ipBucket?.take(clientIp(c, mode, ipSource)) : undefined;
        if (r && !r.ok) return limited(c, r.retryAfterSec);
        throw err;
      }
    }
    await next();
  });

  app.use('/api/team/*', authenticated, agentLimit);
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
  app.post('/api/team/check-files', async (c) => c.json(await checkFiles(ctx, c.get('actor'), (await body(c)) as never)));
  app.post('/api/team/claim-override', async (c) => c.json(await recordClaimOverride(ctx, c.get('actor'), (await body(c)) as never)));
  app.get('/api/team/tasks/:n', async (c) => c.json(await getTaskView(ctx, c.get('actor'), taskNumber(c))));
  app.post('/api/team/tasks/:n/claim', async (c) => c.json(await claimTask(ctx, c.get('actor'), { task: taskNumber(c) })));
  app.post('/api/team/tasks/:n/complete', async (c) => {
    const b = (await body(c)) as Record<string, unknown>;
    return c.json(await completeTask(ctx, c.get('actor'), { ...b, task: taskNumber(c) } as never));
  });
  app.post('/api/team/tasks/:n/merged', async (c) => {
    const b = (await body(c)) as Record<string, unknown>;
    return c.json(await markMerged(ctx, c.get('actor'), { ...b, task: taskNumber(c) } as never));
  });
  app.post('/api/team/messages', async (c) => c.json(await sendMessage(ctx, c.get('actor'), (await body(c)) as never)));
  app.post('/api/team/orchestrator', async (c) => c.json(await setOrchestrator(ctx, c.get('actor'), (await body(c)) as never)));
  app.post('/api/team/invite/rotate', async (c) => c.json(await rotateInvite(ctx, c.get('actor'))));
  app.post('/api/team/invite/revoke', async (c) => c.json(await revokeInvite(ctx, c.get('actor'))));

  app.use('/mcp', authenticated, agentLimit);
  app.get('/mcp', (c) => c.body(null, 405)); // stateless: no server-initiated SSE stream
  app.all('/mcp', async (c) => {
    const server = buildMcpServer(ctx, c.get('actor'));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}
