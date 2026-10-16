import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INVITE_TTL_MS } from '@agentteams/shared';
import { makeTestContext, seedTeam, type TestEnv } from './helpers.js';
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
