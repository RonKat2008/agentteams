import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INVITE_TTL_MS } from '@agentteams/shared';
import { makeTestContext, seedTeam, type TestEnv } from './helpers.js';
import { DomainError } from '../src/errors.js';
import { getActivity } from '../src/services/activity.js';
import { readInbox } from '../src/services/messages.js';
import {
  authenticate, createTeam, getTeamStatus, joinTeam, previewInvite, revokeInvite, rotateInvite, setOrchestrator,
} from '../src/services/teams.js';

let env: TestEnv;
beforeEach(async () => { env = await makeTestContext(); });
afterEach(async () => { await env.close(); });

const githubRepo = { provider: 'github' as const, slug: 'ronit/my-app', defaultBranch: 'main' };

describe('createTeam', () => {
  it('returns credentials and makes the creator the orchestrator', async () => {
    const res = await createTeam(env.ctx, { name: 'dev-squad', member: 'Ronit', tool: 'claude', repo: githubRepo });
    expect(res.agentName).toBe('ronit-claude');
    expect(res.inviteCode).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    expect(res.apiKey).toMatch(/^at_[A-Za-z0-9_-]{43}$/);
    const status = await getTeamStatus(env.ctx, await authenticate(env.ctx, res.apiKey));
    expect(status.team).toEqual({ name: 'dev-squad', repo: githubRepo, orchestrator: 'ronit-claude' });
  });

  it.each(['-x/app', 'me/..', 'me/.', 'a/b/c'])('rejects the unsafe repo slug %s', async (slug) => {
    await expect(
      createTeam(env.ctx, { name: 'x', member: 'ronit', tool: 'claude', repo: { provider: 'github', slug } }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects a github repo without a slug', async () => {
    await expect(
      createTeam(env.ctx, { name: 'x', member: 'ronit', tool: 'claude', repo: { provider: 'github' } }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('joinTeam', () => {
  it('names agents <member>-<tool> and suffixes duplicates', async () => {
    const { inviteCode } = await seedTeam(env);
    const again = await joinTeam(env.ctx, { inviteCode, member: 'dylan', tool: 'claude' });
    const third = await joinTeam(env.ctx, { inviteCode, member: 'dylan', tool: 'claude' });
    expect(again.agentName).toBe('dylan-claude-2');
    expect(third.agentName).toBe('dylan-claude-3');
    expect(again.repo).toEqual(githubRepo);
  });

  it('accepts invite codes case-insensitively with surrounding spaces', async () => {
    const { inviteCode } = await seedTeam(env);
    const res = await joinTeam(env.ctx, { inviteCode: `  ${inviteCode.toUpperCase()} `, member: 'zed', tool: 'other' });
    expect(res.agentName).toBe('zed-other');
  });

  it('rejects unknown codes', async () => {
    await expect(
      joinTeam(env.ctx, { inviteCode: 'aaaa-bbbb-cccc-dddd', member: 'zed', tool: 'claude' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects expired codes', async () => {
    const { inviteCode } = await seedTeam(env);
    env.advance(INVITE_TTL_MS + 1);
    await expect(joinTeam(env.ctx, { inviteCode, member: 'zed', tool: 'claude' })).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('expired'),
    });
  });

  it('rejects revoked codes; a rotated code works and the old one does not', async () => {
    const { inviteCode, ronit } = await seedTeam(env);
    await revokeInvite(env.ctx, ronit);
    await expect(joinTeam(env.ctx, { inviteCode, member: 'zed', tool: 'claude' })).rejects.toMatchObject({ code: 'forbidden' });
    const rotated = await rotateInvite(env.ctx, ronit);
    await expect(joinTeam(env.ctx, { inviteCode, member: 'zed', tool: 'claude' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(joinTeam(env.ctx, { inviteCode: rotated.inviteCode, member: 'zed', tool: 'claude' })).resolves.toMatchObject({ agentName: 'zed-claude' });
  });

  it('only the creator can rotate or revoke invites', async () => {
    const { dylan } = await seedTeam(env);
    await expect(rotateInvite(env.ctx, dylan)).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('ronit') });
    await expect(revokeInvite(env.ctx, dylan)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('creator authority', () => {
  it('is not gained by joining with the creator\'s member name', async () => {
    const { inviteCode, ronit } = await seedTeam(env);
    const impostorJoin = await joinTeam(env.ctx, { inviteCode, member: 'ronit', tool: 'claude' });
    expect(impostorJoin.agentName).toBe('ronit-claude-2');
    const impostor = await authenticate(env.ctx, impostorJoin.apiKey);
    await expect(rotateInvite(env.ctx, impostor)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(revokeInvite(env.ctx, impostor)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setOrchestrator(env.ctx, impostor, { agent: 'ronit-claude-2' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(rotateInvite(env.ctx, ronit)).resolves.toBeDefined();
  });
});

describe('authenticate and presence', () => {
  it('rejects an unknown key', async () => {
    await expect(authenticate(env.ctx, 'at_nope')).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('derives presence from the last heartbeat', async () => {
    const { ronit, keys } = await seedTeam(env);
    const presence = async (name: string) =>
      (await getTeamStatus(env.ctx, ronit)).agents.find((a) => a.name === name)!.presence;

    expect(await presence('dylan-claude')).toBe('active');
    env.advance(61_000);
    expect(await presence('dylan-claude')).toBe('idle');
    env.advance(10 * 60_000);
    expect(await presence('dylan-claude')).toBe('offline');
    await authenticate(env.ctx, keys.dylan);
    expect(await presence('dylan-claude')).toBe('active');
  });

  it('lists every agent with its owner and tool', async () => {
    const { ronit } = await seedTeam(env);
    const status = await getTeamStatus(env.ctx, ronit);
    expect(status.agents.map((a) => [a.name, a.member, a.tool, a.isOrchestrator])).toEqual([
      ['ronit-claude', 'ronit', 'claude', true],
      ['dylan-claude', 'dylan', 'claude', false],
      ['ash-codex', 'ash', 'codex', false],
    ]);
  });
});

describe('setOrchestrator', () => {
  it('lets the creator hand the role to another agent', async () => {
    const { ronit } = await seedTeam(env);
    await expect(setOrchestrator(env.ctx, ronit, { agent: 'ash-codex' })).resolves.toEqual({ orchestrator: 'ash-codex' });
    expect((await getTeamStatus(env.ctx, ronit)).team.orchestrator).toBe('ash-codex');
  });

  it('refuses non-creators', async () => {
    const { dylan } = await seedTeam(env);
    await expect(setOrchestrator(env.ctx, dylan, { agent: 'dylan-claude' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('reports unknown agents', async () => {
    const { ronit } = await seedTeam(env);
    await expect(setOrchestrator(env.ctx, ronit, { agent: 'nobody-claude' })).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('nobody-claude'),
    });
  });
});

describe('previewInvite', () => {
  it('returns the team name and repo without creating an agent', async () => {
    const { inviteCode, ronit } = await seedTeam(env);
    const before = (await getTeamStatus(env.ctx, ronit)).agents.length;
    expect(await previewInvite(env.ctx, { inviteCode })).toEqual({ teamName: 'dev-squad', repo: githubRepo });
    expect((await getTeamStatus(env.ctx, ronit)).agents).toHaveLength(before);
  });

  it('fails like join for unknown, revoked and expired codes', async () => {
    const { inviteCode, ronit } = await seedTeam(env);
    await expect(previewInvite(env.ctx, { inviteCode: 'zzzz-zzzz-zzzz-zzzz' })).rejects.toMatchObject({ code: 'not_found' });
    env.advance(INVITE_TTL_MS + 1);
    await expect(previewInvite(env.ctx, { inviteCode })).rejects.toMatchObject({
      code: 'forbidden', message: expect.stringContaining('expired'),
    });
    const fresh = await rotateInvite(env.ctx, ronit);
    await revokeInvite(env.ctx, ronit);
    await expect(previewInvite(env.ctx, { inviteCode: fresh.inviteCode })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('hosted GitHub identity', () => {
  const TOKENS: Record<string, { login: string; id: number }> = {
    tok_ronit: { login: 'Ronit-K', id: 1 },
    tok_dylan: { login: 'dylan.d', id: 2 },
    tok_ronit2: { login: 'Ronit-K', id: 1 },
  };
  const SECRET = 'tok_ronit';
  let calls: string[];
  let hosted: TestEnv;

  beforeEach(async () => {
    calls = [];
    hosted = await makeTestContext('2026-01-01T00:00:00.000Z', {
      mode: 'hosted',
      verifyGithub: async (token) => {
        calls.push(token);
        const u = TOKENS[token];
        if (!u) throw new DomainError('unauthorized', 'GitHub token rejected');
        return u;
      },
    });
  });
  afterEach(async () => { await hosted.close(); });

  const create = (extra: object = {}) => createTeam(hosted.ctx, {
    name: 'dev-squad', tool: 'claude', repo: githubRepo, githubToken: SECRET, ...extra,
  });

  async function everything(): Promise<string> {
    const rows = [
      await hosted.ctx.db.selectFrom('agents').selectAll().execute(),
      await hosted.ctx.db.selectFrom('activity').selectAll().execute(),
      await hosted.ctx.db.selectFrom('messages').selectAll().execute(),
      await hosted.ctx.db.selectFrom('teams').selectAll().execute(),
    ];
    return JSON.stringify(rows);
  }

  it('derives the member from the verified login, ignores the client member, and stores github_login', async () => {
    const res = await create({ member: 'someone_else' });
    expect(res.agentName).toBe('ronit_k-claude');
    const actor = await authenticate(hosted.ctx, res.apiKey);
    expect(actor.member).toBe('ronit_k');
    const status = await getTeamStatus(hosted.ctx, actor);
    expect(status.agents[0]!.githubLogin).toBe('Ronit-K');
    expect(calls).toEqual([SECRET]);
  });

  it('requires a token on create and join', async () => {
    const msg = 'this hub requires GitHub identity; install gh and run: gh auth login';
    await expect(create({ githubToken: undefined })).rejects.toMatchObject({ code: 'unauthorized', message: msg });
    const { inviteCode } = await create();
    await expect(joinTeam(hosted.ctx, { inviteCode, tool: 'claude' }))
      .rejects.toMatchObject({ code: 'unauthorized', message: msg });
    expect(calls).toEqual([SECRET]);
  });

  it('propagates a rejected token without creating anything', async () => {
    await expect(create({ githubToken: 'tok_bad' })).rejects.toMatchObject({ code: 'unauthorized', message: 'GitHub token rejected' });
    expect(await hosted.ctx.db.selectFrom('teams').selectAll().execute()).toHaveLength(0);
  });

  it('join: names the agent from the login, stores it, and tells the orchestrator how to grant access', async () => {
    const created = await create();
    const joined = await joinTeam(hosted.ctx, { inviteCode: created.inviteCode, member: 'ignored', tool: 'codex', githubToken: 'tok_dylan' });
    expect(joined.agentName).toBe('dylan_d-codex');
    const orch = await authenticate(hosted.ctx, created.apiKey);
    const status = await getTeamStatus(hosted.ctx, orch);
    expect(status.agents.map((a) => a.githubLogin)).toEqual(['Ronit-K', 'dylan.d']);
    const msgs = await readInbox(hosted.ctx, orch);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      from: 'dylan_d-codex', kind: 'fyi',
      body: 'dylan_d-codex (GitHub @dylan.d) joined. If they need push access to ronit/my-app, run: agentteams access grant dylan_d-codex',
    });
    const events = await getActivity(hosted.ctx, orch);
    const joinEvent = events.filter((e) => e.type === 'agent_joined').at(-1)!;
    expect(joinEvent.data).toMatchObject({ agent: 'dylan_d-codex', githubLogin: 'dylan.d' });
  });

  it('join: no access-request notice when the joiner is the orchestrator member', async () => {
    const created = await create();
    await joinTeam(hosted.ctx, { inviteCode: created.inviteCode, tool: 'codex', githubToken: 'tok_ronit2' });
    const orch = await authenticate(hosted.ctx, created.apiKey);
    expect(await readInbox(hosted.ctx, orch)).toHaveLength(0);
  });

  it('join: no access-request notice for a team without a GitHub repo', async () => {
    const created = await create({ repo: { provider: 'local', defaultBranch: 'main' } });
    await joinTeam(hosted.ctx, { inviteCode: created.inviteCode, tool: 'codex', githubToken: 'tok_dylan' });
    const orch = await authenticate(hosted.ctx, created.apiKey);
    expect(await readInbox(hosted.ctx, orch)).toHaveLength(0);
  });

  it('never leaks the token into responses, rows or errors', async () => {
    const created = await create();
    const joined = await joinTeam(hosted.ctx, { inviteCode: created.inviteCode, tool: 'codex', githubToken: 'tok_dylan' });
    const failures = await Promise.all([
      create({ githubToken: 'tok_leakcheck' }).catch((e: Error) => e.message),
      joinTeam(hosted.ctx, { inviteCode: created.inviteCode, tool: 'codex', githubToken: 'tok_leakcheck' }).catch((e: Error) => e.message),
    ]);
    const blob = JSON.stringify([created, joined, failures]) + (await everything());
    for (const secret of [SECRET, 'tok_dylan', 'tok_leakcheck']) expect(blob).not.toContain(secret);
  });
});

describe('local mode ignores GitHub tokens', () => {
  it('does not verify or store a supplied token and still requires a member', async () => {
    let verified = 0;
    const local = await makeTestContext('2026-01-01T00:00:00.000Z', {
      verifyGithub: async () => { verified++; return { login: 'x', id: 1 }; },
    });
    try {
      const res = await createTeam(local.ctx, { name: 'x', member: 'ronit', tool: 'claude', repo: githubRepo, githubToken: 'tok_local' });
      expect(res.agentName).toBe('ronit-claude');
      const j = await joinTeam(local.ctx, { inviteCode: res.inviteCode, member: 'dylan', tool: 'claude', githubToken: 'tok_local' });
      expect(j.agentName).toBe('dylan-claude');
      expect(verified).toBe(0);
      const rows = await local.ctx.db.selectFrom('agents').select('github_login').execute();
      expect(rows.every((r) => r.github_login === null)).toBe(true);
      const status = await getTeamStatus(local.ctx, await authenticate(local.ctx, res.apiKey));
      expect(status.agents.every((a) => a.githubLogin === null)).toBe(true);
      await expect(createTeam(local.ctx, { name: 'y', tool: 'claude', repo: githubRepo })).rejects.toMatchObject({ code: 'invalid' });
      await expect(joinTeam(local.ctx, { inviteCode: res.inviteCode, tool: 'claude' })).rejects.toMatchObject({ code: 'invalid' });
    } finally { await local.close(); }
  });
});
