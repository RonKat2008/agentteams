import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestContext, seedTeam, type TestEnv } from './helpers.js';
import { withTx } from '../src/context.js';
import { markRead, readInbox, sendMessage } from '../src/services/messages.js';
import { createReplicatedTeam, registerReplicatedAgent } from '../src/services/replication.js';
import { authenticate, joinTeam } from '../src/services/teams.js';

let env: TestEnv;
beforeEach(async () => { env = await makeTestContext(); });
afterEach(async () => { await env.close(); });

const KEY_A = 'A'.repeat(43);
const KEY_B = 'B'.repeat(43);
const CREATOR = '01JABCDEFGHJKMNPQRSTVWXYZ0';
const JOINER = '01JABCDEFGHJKMNPQRSTVWXYZ1';

describe('markRead', () => {
  it('marks only messages the actor can see, and is idempotent', async () => {
    const { ronit, dylan, ash } = await seedTeam(env);
    const toRonit = await sendMessage(env.ctx, dylan, { to: 'ronit-claude', body: 'for ronit' });
    const toAsh = await sendMessage(env.ctx, dylan, { to: 'ash-codex', body: 'for ash' });
    const own = await sendMessage(env.ctx, ronit, { to: 'all', body: 'from ronit' });
    expect(await markRead(env.ctx, ronit, { messageIds: [toRonit.id, toAsh.id, own.id, toRonit.id] })).toEqual({ marked: 1 });
    expect(await markRead(env.ctx, ronit, { messageIds: [toRonit.id] })).toEqual({ marked: 0 });
    expect(await readInbox(env.ctx, ronit, { markRead: false })).toEqual([]);
    expect((await readInbox(env.ctx, ash, { markRead: false })).map((m) => m.body)).toEqual(['for ash', 'from ronit']);
  });

  it('does not mark broadcasts sent before the actor joined', async () => {
    const { ronit, inviteCode } = await seedTeam(env);
    const early = await sendMessage(env.ctx, ronit, { to: 'all', body: 'early' });
    env.advance(10);
    const joined = await joinTeam(env.ctx, { inviteCode, member: 'kai', tool: 'cursor' });
    const kai = await authenticate(env.ctx, joined.apiKey);
    expect(await markRead(env.ctx, kai, { messageIds: [early.id] })).toEqual({ marked: 0 });
  });

  it('rejects malformed ids', async () => {
    const { ronit } = await seedTeam(env);
    await expect(markRead(env.ctx, ronit, { messageIds: ['nope'] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(markRead(env.ctx, ronit, { messageIds: [] })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('replicated team bootstrap', () => {
  const team = {
    teamId: 'team-1', name: 'alpha', repo: { provider: 'local' as const, defaultBranch: 'main' },
    member: 'ronit', tool: 'claude' as const, agentId: CREATOR, agentName: 'ronit-claude', publicKey: KEY_A,
  };
  const join = { teamId: 'team-1', member: 'dylan', tool: 'claude' as const, agentId: JOINER, agentName: 'dylan-claude', publicKey: KEY_B };

  it('creates the team, creator, key and activity once', async () => {
    await createReplicatedTeam(env.ctx, CREATOR, team);
    const t = await env.ctx.db.selectFrom('teams').selectAll().executeTakeFirstOrThrow();
    expect(t).toMatchObject({ id: 'team-1', orchestrator_agent_id: CREATOR, creator_agent_id: CREATOR, invite_revoked: 1 });
    expect(t.invite_code_hash).toBe('replica:team-1');
    const key = await env.ctx.db.selectFrom('agent_keys').selectAll().executeTakeFirstOrThrow();
    expect(key).toMatchObject({ agent_id: CREATOR, public_key: KEY_A, team_id: 'team-1' });
    const types = (await env.ctx.db.selectFrom('activity').select('type').orderBy('id').execute()).map((r) => r.type);
    expect(types).toEqual(['team_created', 'agent_joined']);
    await expect(createReplicatedTeam(env.ctx, CREATOR, team)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('only lets an agent register its own key', async () => {
    await expect(createReplicatedTeam(env.ctx, JOINER, team)).rejects.toMatchObject({ code: 'forbidden' });
    await createReplicatedTeam(env.ctx, CREATOR, team);
    await expect(registerReplicatedAgent(env.ctx, CREATOR, join)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('joins once; same key is a no-op, a different key is rejected, a taken name gets a suffix', async () => {
    await createReplicatedTeam(env.ctx, CREATOR, team);
    expect(await registerReplicatedAgent(env.ctx, JOINER, join)).toEqual({ agentName: 'dylan-claude', alreadyRegistered: false });
    expect(await registerReplicatedAgent(env.ctx, JOINER, join)).toEqual({ agentName: 'dylan-claude', alreadyRegistered: true });
    await expect(registerReplicatedAgent(env.ctx, JOINER, { ...join, publicKey: KEY_A })).rejects.toMatchObject({ code: 'conflict' });
    const third = '01JABCDEFGHJKMNPQRSTVWXYZ2';
    const fourth = '01JABCDEFGHJKMNPQRSTVWXYZ3';
    expect(await registerReplicatedAgent(env.ctx, third, { ...join, agentId: third }))
      .toEqual({ agentName: 'dylan-claude-2', alreadyRegistered: false });
    expect(await registerReplicatedAgent(env.ctx, fourth, { ...join, agentId: fourth }))
      .toEqual({ agentName: 'dylan-claude-3', alreadyRegistered: false });
    await expect(registerReplicatedAgent(env.ctx, third, { ...join, agentId: third, teamId: 'nope', agentName: 'x-claude' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('withTx joinOuterTx', () => {
  it('runs inside an outer transaction only when the context opts in', async () => {
    const trx = await env.ctx.db.startTransaction().execute();
    try {
      await expect(withTx({ ...env.ctx, db: trx }, async () => 1)).rejects.toThrow('withTx must not be nested');
      await expect(withTx({ ...env.ctx, db: trx, joinOuterTx: true }, async () => 2)).resolves.toBe(2);
    } finally {
      await trx.rollback().execute();
    }
  });
});
