import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestContext, type TestEnv } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { sendMessage } from '../src/services/messages.js';
import { authenticate } from '../src/services/teams.js';

let env: TestEnv;
let app: ReturnType<typeof createApp>;
beforeEach(async () => { env = await makeTestContext(); app = createApp(env.ctx); });
afterEach(async () => { await env.close(); });

const json = (body: unknown, key?: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify(body),
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
    expect(await (await app.request('/health')).json()).toEqual({ ok: true });
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
