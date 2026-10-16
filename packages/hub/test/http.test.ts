import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestContext, type TestEnv } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { sendMessage } from '../src/services/messages.js';
import { authenticate } from '../src/services/teams.js';
import { createTask } from '../src/services/tasks.js';

let env: TestEnv;
let app: ReturnType<typeof createApp>;
beforeEach(async () => { env = await makeTestContext(); app = createApp(env.ctx); });
afterEach(async () => { await env.close(); });

const json = (body: unknown, key?: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify(body),
});
it('returns a JSON 404 for unknown routes', async () => {
  const res = await app.request('/nope');
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'route not found' } });
});

const get = (key: string): RequestInit => ({ headers: { authorization: `Bearer ${key}` } });

async function bootstrap() {
  const created = await (await app.request('/api/teams', json({
    name: 'dev-squad', member: 'ronit', tool: 'claude', repo: { provider: 'local' },
  }))).json();
  const joined = await (await app.request('/api/join', json({ inviteCode: created.inviteCode, member: 'ash', tool: 'codex' }))).json();
  return { ronitKey: created.apiKey as string, ashKey: joined.apiKey as string, inviteCode: created.inviteCode as string };
}

describe('public routes', () => {
  it('reports health', async () => {
    expect(await (await app.request('/health')).json()).toEqual({ ok: true, mode: 'local' });
  });

  it('creates and joins teams with 201', async () => {
    const res = await app.request('/api/teams', json({ name: 's', member: 'ronit', tool: 'claude', repo: { provider: 'local' } }));
    expect(res.status).toBe(201);
    const body = await res.json();
    const join = await app.request('/api/join', json({ inviteCode: body.inviteCode, member: 'ash', tool: 'codex' }));
    expect(join.status).toBe(201);
    expect(await join.json()).toMatchObject({ agentName: 'ash-codex', teamName: 's' });
  });

  it('returns 400 for malformed JSON and invalid input', async () => {
    const bad = await app.request('/api/teams', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('invalid');
    const invalid = await app.request('/api/teams', json({ name: '' }));
    expect(invalid.status).toBe(400);
  });

  it('returns 404 for an unknown invite code', async () => {
    const res = await app.request('/api/join', json({ inviteCode: 'aaaa-bbbb-cccc-dddd', member: 'zed', tool: 'claude' }));
    expect(res.status).toBe(404);
  });
});

describe('authenticated routes', () => {
  it('rejects missing and bad tokens with 401 and no detail', async () => {
    const missing = await app.request('/api/team/status');
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: { code: 'unauthorized', message: 'missing bearer API key' } });
    const bad = await app.request('/api/team/status', get('at_garbage'));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: { code: 'unauthorized', message: 'invalid API key' } });
  });

  it('ping returns unread messages once', async () => {
    const { ronitKey, ashKey } = await bootstrap();
    await sendMessage(env.ctx, await authenticate(env.ctx, ronitKey), { to: 'ash-codex', body: 'hello' });
    const first = await (await app.request('/api/team/ping', json({}, ashKey))).json();
    expect(first).toEqual({ agent: 'ash-codex', messages: [expect.objectContaining({ from: 'ronit-claude', body: 'hello' })] });
    const second = await (await app.request('/api/team/ping', json({}, ashKey))).json();
    expect(second.messages).toEqual([]);
  });

  it('serves team status', async () => {
    const { ronitKey } = await bootstrap();
    const status = await (await app.request('/api/team/status', get(ronitKey))).json();
    expect(status.team.orchestrator).toBe('ronit-claude');
    expect(status.agents).toHaveLength(2);
  });

  it('records commits and serves changes, activity, who-owns and tasks', async () => {
    const { ashKey, ronitKey } = await bootstrap();
    const commitRes = await app.request('/api/team/commits', json({
      sha: 'abcdef1', branch: 'main', message: 'init', files: ['README.md'], insertions: 1, deletions: 0,
    }, ashKey));
    expect(commitRes.status).toBe(200);
    expect((await (await app.request('/api/team/changes', get(ronitKey))).json())[0]).toMatchObject({ sha: 'abcdef1', agent: 'ash-codex' });
    const activity = await (await app.request('/api/team/activity?limit=1', get(ronitKey))).json();
    expect(activity).toEqual([expect.objectContaining({ type: 'commit' })]);
    expect(await (await app.request('/api/team/who-owns?path=README.md', get(ronitKey))).json()).toEqual([]);
    expect(await (await app.request('/api/team/tasks', get(ronitKey))).json()).toEqual([]);
  });

  it('maps forbidden to 403 and validation to 400', async () => {
    const { ashKey } = await bootstrap();
    const forbidden = await app.request('/api/team/orchestrator', json({ agent: 'ash-codex' }, ashKey));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.message).toContain('ronit');
    const invalid = await app.request('/api/team/who-owns?path=/etc/passwd', get(ashKey));
    expect(invalid.status).toBe(400);
  });

  it('lets the creator rotate and revoke invites', async () => {
    const { ronitKey, inviteCode } = await bootstrap();
    const rotated = await (await app.request('/api/team/invite/rotate', json({}, ronitKey))).json();
    expect(rotated.inviteCode).not.toBe(inviteCode);
    expect((await app.request('/api/team/invite/revoke', json({}, ronitKey))).status).toBe(200);
  });
});

describe('local hardening', () => {
  it('rejects non-JSON POST bodies with 415', async () => {
    const res = await app.request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': '1' },
      body: JSON.stringify({ name: 's', member: 'ronit', tool: 'claude', repo: { provider: 'local' } }),
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: { code: 'invalid', message: 'Content-Type must be application/json' } });
  });

  it('accepts application/json with a charset parameter', async () => {
    const res = await app.request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ name: 's', member: 'ronit', tool: 'claude', repo: { provider: 'local' } }),
    });
    expect(res.status).toBe(201);
  });

  it('allows a bodyless POST (e.g. invite rotate) without a content type', async () => {
    const { ronitKey } = await bootstrap();
    const res = await app.request('/api/team/invite/rotate', { method: 'POST', headers: { authorization: `Bearer ${ronitKey}` } });
    expect(res.status).toBe(200);
  });
});

describe('host allowlist', () => {
  it('refuses requests whose Host is not allowed', async () => {
    const strict = createApp(env.ctx, { allowedHosts: ['127.0.0.1', 'localhost'] });
    const evil = await strict.request('http://evil.example/api/team/status');
    expect(evil.status).toBe(403);
    expect(await evil.json()).toEqual({ error: { code: 'forbidden', message: 'host not allowed' } });
    expect((await strict.request('http://127.0.0.1:4747/health')).status).toBe(200);
    expect((await strict.request('http://localhost:4747/health')).status).toBe(200);
  });
});

describe('git-layer routes', () => {
  async function setup() {
    const keys = await bootstrap();
    const ronit = await authenticate(env.ctx, keys.ronitKey);
    await createTask(env.ctx, ronit, { title: 'Build login', assignee: 'ash-codex' });
    return keys;
  }
  const getJson = (path: string, key: string) => app.request(path, get(key));

  it('previews an invite without auth', async () => {
    const { inviteCode } = await bootstrap();
    const res = await app.request('/api/join/preview', json({ inviteCode }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ teamName: 'dev-squad' });
  });

  it('checks files and records a claim override', async () => {
    const { ronitKey, ashKey } = await setup();
    const check = await app.request('/api/team/check-files', json({ paths: ['src/a.ts'] }, ashKey));
    expect(check.status).toBe(200);
    expect(await check.json()).toHaveProperty('conflicts');
    const override = await app.request('/api/team/claim-override', json({ paths: ['src/a.ts'] }, ashKey));
    expect(override.status).toBe(200);
    expect(await override.json()).toHaveProperty('owners');
  });

  it('claims, completes, merges and fetches a task', async () => {
    const { ronitKey, ashKey } = await setup();
    const claim = await app.request('/api/team/tasks/1/claim', json({}, ashKey));
    expect(claim.status).toBe(200);
    expect((await claim.json()).status).toBe('in_progress');
    const done = await app.request('/api/team/tasks/1/complete', json({ summary: 'done', branch: 'at/ash-codex/1' }, ashKey));
    expect((await done.json()).status).toBe('done');
    const merged = await app.request('/api/team/tasks/1/merged', json({ pr: 'https://github.com/o/r/pull/1' }, ronitKey));
    expect(merged.status).toBe(200);
    expect((await merged.json()).mergedAt).toBeTruthy();
    const view = await getJson('/api/team/tasks/1', ashKey);
    expect(view.status).toBe(200);
    expect((await view.json()).number).toBe(1);
  });

  it('maps errors: 403 non-orchestrator merged, 404 unknown task, 400 bad number', async () => {
    const { ashKey } = await setup();
    expect((await app.request('/api/team/tasks/1/merged', json({}, ashKey))).status).toBe(403);
    expect((await getJson('/api/team/tasks/99', ashKey)).status).toBe(404);
    expect((await getJson('/api/team/tasks/abc', ashKey)).status).toBe(400);
    expect((await app.request('/api/team/tasks/abc/claim', json({}, ashKey))).status).toBe(400);
  });
});

describe('hardening', () => {
  it('reports the configured mode on /health', async () => {
    const hosted = createApp(env.ctx, { mode: 'hosted' });
    expect(await (await hosted.request('/health')).json()).toEqual({ ok: true, mode: 'hosted' });
  });

  it('rejects a 70 KB body with 413', async () => {
    const res = await app.request('/api/teams', json({ name: 'x'.repeat(70 * 1024) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: 'invalid', message: 'request body too large' } });
  });

  it('rate limits unauthenticated routes per IP (10/min)', async () => {
    let t = 0;
    const limited = createApp(env.ctx, { mode: 'hosted', now: () => t });
    const hit = () => limited.request('/api/join/preview', {
      ...json({ inviteCode: 'aaaa-bbbb-cccc-dddd' }), headers: { 'content-type': 'application/json', 'fly-client-ip': '9.9.9.9' },
    });
    for (let i = 0; i < 10; i++) expect((await hit()).status).not.toBe(429);
    const res = await hit();
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.message).toMatch(/^too many requests; retry in \d+s$/);
    const other = await limited.request('/api/join/preview', {
      ...json({ inviteCode: 'aaaa-bbbb-cccc-dddd' }), headers: { 'content-type': 'application/json', 'fly-client-ip': '8.8.8.8' },
    });
    expect(other.status).not.toBe(429);
    t += 60_000;
    expect((await hit()).status).not.toBe(429);
  });

  it('rate limits authenticated requests per agent (60/min)', async () => {
    let t = 0;
    const limited = createApp(env.ctx, { now: () => t, rateLimits: { agentPerMin: 60, ipPerMin: 10 } });
    const created = await (await limited.request('/api/teams', json({
      name: 'rl', member: 'ronit', tool: 'claude', repo: { provider: 'local' },
    }))).json();
    for (let i = 0; i < 60; i++) expect((await limited.request('/api/team/status', get(created.apiKey))).status).toBe(200);
    const res = await limited.request('/api/team/status', get(created.apiKey));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).not.toBeNull();
    t += 60_000;
    expect((await limited.request('/api/team/status', get(created.apiKey))).status).toBe(200);
  });

  it('sets WWW-Authenticate on 401 from /mcp', async () => {
    const res = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="agentteams"');
  });

  it('exempts /health from the Host allowlist but not other routes', async () => {
    const hosted = createApp(env.ctx, { mode: 'hosted', allowedHosts: ['hub.example.com'] });
    const headers = { host: '10.0.0.5:8080' };
    expect((await hosted.request('/health', { headers })).status).toBe(200);
    expect((await hosted.request('/api/team/status', { headers })).status).toBe(403);
  });

  it('rejects an oversized /mcp body with 413', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it('throttles failed auth against the IP limit', async () => {
    const hosted = createApp(env.ctx, { mode: 'hosted', now: () => 0 });
    const guess = (path: string) => hosted.request(path, { headers: { authorization: 'Bearer nope', 'fly-client-ip': '7.7.7.7' } });
    for (let i = 0; i < 10; i++) expect((await guess(i % 2 ? '/api/team/status' : '/mcp')).status).toBe(401);
    const res = await guess('/api/team/status');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).not.toBeNull();
  });
});
