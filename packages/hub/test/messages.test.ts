import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestContext, seedTeam, type TestEnv } from './helpers.js';
import { readInbox, sendMessage } from '../src/services/messages.js';
import { authenticate, joinTeam, setOrchestrator } from '../src/services/teams.js';
import { getActivity } from '../src/services/activity.js';

let env: TestEnv;
beforeEach(async () => { env = await makeTestContext(); });
afterEach(async () => { await env.close(); });

describe('direct messages', () => {
  it('are delivered once and then marked read', async () => {
    const { ronit, dylan } = await seedTeam(env);
    await sendMessage(env.ctx, dylan, { to: 'ronit-claude', body: 'auth is done', kind: 'fyi' });
    const first = await readInbox(env.ctx, ronit);
    expect(first).toEqual([
      expect.objectContaining({ from: 'dylan-claude', fromRole: 'peer', to: 'ronit-claude', kind: 'fyi', body: 'auth is done' }),
    ]);
    expect(await readInbox(env.ctx, ronit)).toEqual([]);
  });

  it('stay unread when markRead is false', async () => {
    const { ronit, dylan } = await seedTeam(env);
    await sendMessage(env.ctx, dylan, { to: 'ronit-claude', body: 'ping' });
    expect(await readInbox(env.ctx, ronit, { markRead: false })).toHaveLength(1);
    expect(await readInbox(env.ctx, ronit)).toHaveLength(1);
  });

  it('with a limit only consume (mark read) that many, oldest first', async () => {
    const { ronit, dylan } = await seedTeam(env);
    for (const b of ['one', 'two', 'three']) await sendMessage(env.ctx, dylan, { to: 'ronit-claude', body: b });
    expect((await readInbox(env.ctx, ronit, { limit: 2 })).map((m) => m.body)).toEqual(['one', 'two']);
    expect((await readInbox(env.ctx, ronit)).map((m) => m.body)).toEqual(['three']);
  });

  it('are not visible to other agents', async () => {
    const { ash, dylan } = await seedTeam(env);
    await sendMessage(env.ctx, dylan, { to: 'ronit-claude', body: 'private' });
    expect(await readInbox(env.ctx, ash)).toEqual([]);
  });
});

describe('concurrent reads', () => {
  it('two simultaneous readInbox calls do not crash and mark the message read', async () => {
    const { dylan, ash } = await seedTeam(env);
    await sendMessage(env.ctx, dylan, { to: 'ash-codex', body: 'race', kind: 'fyi' });
    await expect(Promise.all([readInbox(env.ctx, ash), readInbox(env.ctx, ash)])).resolves.toBeDefined();
    expect(await readInbox(env.ctx, ash)).toEqual([]);
  });
});

describe('from_role', () => {
  it('is frozen at send time and survives an orchestrator change', async () => {
    const { ronit, dylan, ash } = await seedTeam(env);
    await sendMessage(env.ctx, dylan, { to: 'ash-codex', body: 'peer note', kind: 'fyi' });
    await sendMessage(env.ctx, ronit, { to: 'ash-codex', body: 'do it', kind: 'command' });
    await setOrchestrator(env.ctx, ronit, { agent: 'dylan-claude' });
    const inbox = await readInbox(env.ctx, ash);
    expect(inbox.map((m) => [m.from, m.fromRole])).toEqual([
      ['dylan-claude', 'peer'],
      ['ronit-claude', 'orchestrator'],
    ]);
  });
});

describe('broadcasts', () => {
  it('reach every other agent independently but not the sender', async () => {
    const { ronit, dylan, ash } = await seedTeam(env);
    await sendMessage(env.ctx, ronit, { to: 'all', body: 'standup in 5' });
    expect(await readInbox(env.ctx, ronit)).toEqual([]);
    expect((await readInbox(env.ctx, dylan)).map((m) => [m.body, m.to, m.fromRole])).toEqual([['standup in 5', 'all', 'orchestrator']]);
    expect(await readInbox(env.ctx, ash)).toHaveLength(1);
    expect(await readInbox(env.ctx, dylan)).toEqual([]);
  });

  it('sent before an agent joined are not delivered to it', async () => {
    const { ronit, inviteCode } = await seedTeam(env);
    await sendMessage(env.ctx, ronit, { to: 'all', body: 'old news' });
    env.advance(1000);
    const late = await joinTeam(env.ctx, { inviteCode, member: 'zed', tool: 'claude' });
    expect(await readInbox(env.ctx, await authenticate(env.ctx, late.apiKey))).toEqual([]);
  });
});

describe('permissions and validation', () => {
  it('only the orchestrator can send commands', async () => {
    const { ronit, dylan } = await seedTeam(env);
    await expect(sendMessage(env.ctx, dylan, { to: 'ash-codex', body: 'do it', kind: 'command' }))
      .rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('ronit-claude') });
    await expect(sendMessage(env.ctx, ronit, { to: 'ash-codex', body: 'do it', kind: 'command' }))
      .resolves.toMatchObject({ to: 'ash-codex' });
  });

  it('rejects unknown recipients, self-messages and empty bodies', async () => {
    const { dylan } = await seedTeam(env);
    await expect(sendMessage(env.ctx, dylan, { to: 'ghost-claude', body: 'hi' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(sendMessage(env.ctx, dylan, { to: 'dylan-claude', body: 'hi' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(sendMessage(env.ctx, dylan, { to: 'all', body: '' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('logs message_sent with a short preview', async () => {
    const { ronit, dylan } = await seedTeam(env);
    await sendMessage(env.ctx, dylan, { to: 'all', body: 'x'.repeat(200) });
    const last = (await getActivity(env.ctx, ronit)).at(-1)!;
    expect(last.type).toBe('message_sent');
    expect(last.data).toMatchObject({ to: 'all', kind: 'fyi' });
    expect((last.data.preview as string).length).toBeLessThanOrEqual(80);
  });
});
