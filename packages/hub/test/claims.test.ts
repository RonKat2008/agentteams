import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestContext, seedTeam, type TestEnv } from './helpers.js';
import { checkFiles, claimFiles, listActiveClaims, globsOverlap, recordClaimOverride, releaseFiles, whoOwns } from '../src/services/claims.js';
import { readInbox } from '../src/services/messages.js';
import { getActivity } from '../src/services/activity.js';
import { createTeam } from '../src/services/teams.js';
import { getTeamStatus } from '../src/services/teams.js';

let env: TestEnv;
beforeEach(async () => { env = await makeTestContext(); });
afterEach(async () => { await env.close(); });

describe('globsOverlap', () => {
  it.each([
    ['src/auth/**', 'src/auth/login.ts', true],
    ['src/auth/login.ts', 'src/auth/**', true],
    ['src/auth/login.ts', 'src/auth/login.ts', true],
    ['src/**/*.ts', 'src/auth/login.ts', true],
    ['.env*', '.env.local', true],
    ['src/auth/**', 'src/billing/**', false],
    ['docs/*.md', 'src/index.ts', false],
  ])('%s vs %s → %s', (a, b, expected) => {
    expect(globsOverlap(a, b)).toBe(expected);
  });
});

describe('claimFiles', () => {
  it('grants exactly one of two concurrent overlapping exclusive claims', async () => {
    const { ash, dylan } = await seedTeam(env);
    const [a, b] = await Promise.all([
      claimFiles(env.ctx, ash, { globs: ['src/auth/**'] }),
      claimFiles(env.ctx, dylan, { globs: ['src/auth/login.ts'] }),
    ]);
    expect([a.granted, b.granted].filter(Boolean)).toHaveLength(1);
    expect(await listActiveClaims(env.ctx, ash.teamId)).toHaveLength(1);
  });

  it('grants a free claim and shows it in team status', async () => {
    const { ash, ronit } = await seedTeam(env);
    const res = await claimFiles(env.ctx, ash, { globs: ['src/auth/**'] });
    expect(res).toMatchObject({ granted: true, conflicts: [], claims: [{ agent: 'ash-codex', glob: 'src/auth/**', exclusive: true }] });
    expect((await getTeamStatus(env.ctx, ronit)).agents.find((a) => a.name === 'ash-codex')!.claims).toEqual(['src/auth/**']);
  });

  it('refuses an overlapping exclusive claim and names the holder', async () => {
    const { ash, dylan } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['src/auth/**'] });
    const res = await claimFiles(env.ctx, dylan, { globs: ['src/auth/login.ts', 'README.md'] });
    expect(res.granted).toBe(false);
    expect(res.claims).toEqual([]);
    expect(res.conflicts).toEqual([expect.objectContaining({ agent: 'ash-codex', glob: 'src/auth/**' })]);
    expect(await whoOwns(env.ctx, dylan, { path: 'README.md' })).toEqual([]); // all-or-nothing
  });

  it('allows overlapping claims when both are shared', async () => {
    const { ash, dylan } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['package.json'], exclusive: false });
    expect((await claimFiles(env.ctx, dylan, { globs: ['package.json'], exclusive: false })).granted).toBe(true);
  });

  it('a shared claim still conflicts with an existing exclusive one', async () => {
    const { ash, dylan } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['package.json'] });
    expect((await claimFiles(env.ctx, dylan, { globs: ['package.json'], exclusive: false })).granted).toBe(false);
  });

  it('ignores expired claims', async () => {
    const { ash, dylan } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['src/**'], ttlMin: 1 });
    env.advance(60_001);
    expect((await claimFiles(env.ctx, dylan, { globs: ['src/index.ts'] })).granted).toBe(true);
    expect((await whoOwns(env.ctx, dylan, { path: 'src/app.ts' })).map((c) => c.agent)).toEqual([]);
  });

  it('re-claiming your own glob renews it instead of duplicating', async () => {
    const { ash, ronit } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['src/**'], ttlMin: 1 });
    env.advance(30_000);
    const res = await claimFiles(env.ctx, ash, { globs: ['src/**'], ttlMin: 60 });
    expect(res.claims[0]!.expiresAt).toBe(new Date(Date.parse('2026-01-01T00:00:30.000Z') + 60 * 60_000).toISOString());
    expect((await getTeamStatus(env.ctx, ronit)).agents.find((a) => a.name === 'ash-codex')!.claims).toEqual(['src/**']);
  });

  it('lets only one of two concurrent overlapping exclusive claims win', async () => {
    const { ash, dylan } = await seedTeam(env);
    const [a, d] = await Promise.all([
      claimFiles(env.ctx, ash, { globs: ['src/**'] }),
      claimFiles(env.ctx, dylan, { globs: ['src/index.ts'] }),
    ]);
    expect([a.granted, d.granted].filter(Boolean)).toHaveLength(1);
  });

  it('rejects absolute and parent-relative globs', async () => {
    const { ash } = await seedTeam(env);
    await expect(claimFiles(env.ctx, ash, { globs: ['/etc/passwd'] })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('whoOwns and releaseFiles', () => {
  it('reports every active claim that matches a path', async () => {
    const { ash, dylan } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['src/auth/**'] });
    await claimFiles(env.ctx, dylan, { globs: ['docs/**'] });
    expect((await whoOwns(env.ctx, dylan, { path: 'src/auth/login.ts' })).map((c) => c.agent)).toEqual(['ash-codex']);
  });

  it('rejects an empty globs array and releases nothing', async () => {
    const { ash } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['a/**'] });
    await expect(releaseFiles(env.ctx, ash, { globs: [] })).rejects.toMatchObject({ code: 'invalid' });
    expect(await whoOwns(env.ctx, ash, { path: 'a/x.ts' })).toHaveLength(1);
  });

  it("releases specific globs or everything you hold, never others' claims", async () => {
    const { ash, dylan } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['a/**', 'b/**'] });
    await claimFiles(env.ctx, dylan, { globs: ['c/**'] });
    expect(await releaseFiles(env.ctx, ash, { globs: ['a/**'] })).toEqual({ released: 1 });
    expect(await releaseFiles(env.ctx, ash)).toEqual({ released: 1 });
    expect(await whoOwns(env.ctx, ash, { path: 'c/x.ts' })).toHaveLength(1);
  });
});

describe('checkFiles', () => {
  it("reports another agent's exclusive claim with agent, glob and expiry", async () => {
    const { ash, dylan } = await seedTeam(env);
    const claimed = await claimFiles(env.ctx, ash, { globs: ['src/**'] });
    const res = await checkFiles(env.ctx, dylan, { paths: ['src/a.ts'] });
    expect(res.conflicts).toEqual([
      { path: 'src/a.ts', agent: 'ash-codex', glob: 'src/**', expiresAt: claimed.claims[0]!.expiresAt },
    ]);
  });

  it("ignores the caller's own claims", async () => {
    const { ash } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['src/**'] });
    expect((await checkFiles(env.ctx, ash, { paths: ['src/a.ts'] })).conflicts).toEqual([]);
  });

  it('ignores non-exclusive claims', async () => {
    const { ash, dylan } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['src/**'], exclusive: false });
    expect((await checkFiles(env.ctx, dylan, { paths: ['src/a.ts'] })).conflicts).toEqual([]);
  });

  it('ignores expired claims', async () => {
    const { ash, dylan } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['src/**'], ttlMin: 1 });
    env.advance(60_001);
    expect((await checkFiles(env.ctx, dylan, { paths: ['src/a.ts'] })).conflicts).toEqual([]);
  });

  it('sorts conflicts by path then agent', async () => {
    const { ash, dylan, ronit } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['docs/**'] });
    await claimFiles(env.ctx, dylan, { globs: ['src/**'] });
    const res = await checkFiles(env.ctx, ronit, { paths: ['src/z.ts', 'docs/a.md'] });
    expect(res.conflicts.map((c) => [c.path, c.agent])).toEqual([['docs/a.md', 'ash-codex'], ['src/z.ts', 'dylan-claude']]);
  });

  it('rejects parent-relative paths and control characters', async () => {
    const { dylan } = await seedTeam(env);
    await expect(checkFiles(env.ctx, dylan, { paths: ['../x'] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(checkFiles(env.ctx, dylan, { paths: ['src/a\u0007.ts'] })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('recordClaimOverride', () => {
  it('logs one claim_overridden event and tells the owner which path', async () => {
    const { ash, dylan, ronit } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['src/**'] });
    const res = await recordClaimOverride(env.ctx, dylan, { paths: ['src/a.ts', 'src/b.ts', 'README.md'], sha: 'abc1234' });
    expect(res).toEqual({ owners: ['ash-codex'] });
    const events = (await getActivity(env.ctx, ronit)).filter((e) => e.type === 'claim_overridden');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ paths: ['src/a.ts', 'src/b.ts'], owners: ['ash-codex'], sha: 'abc1234' });
    const inbox = await readInbox(env.ctx, ash);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: 'fyi', from: 'dylan-claude' });
    expect(inbox[0]!.body).toBe('dylan-claude committed over your claim on src/a.ts, src/b.ts (AGENTTEAMS_ALLOW=1)');
  });

  it('does nothing when there are no conflicts', async () => {
    const { dylan, ronit } = await seedTeam(env);
    expect(await recordClaimOverride(env.ctx, dylan, { paths: ['src/a.ts'] })).toEqual({ owners: [] });
    expect((await getActivity(env.ctx, ronit)).filter((e) => e.type === 'claim_overridden')).toEqual([]);
  });
});

describe('cross-team isolation and tie-breaks', () => {
  const otherTeam = async () => {
    const t = await createTeam(env.ctx, { name: 'other', member: 'zed', tool: 'claude', repo: { provider: 'local', defaultBranch: 'main' } });
    const { authenticate } = await import('../src/services/teams.js');
    return authenticate(env.ctx, t.apiKey);
  };

  it("hides another team's claims from checkFiles and recordClaimOverride", async () => {
    const { dylan, ronit } = await seedTeam(env);
    const zed = await otherTeam();
    await claimFiles(env.ctx, zed, { globs: ['src/**'] });
    expect((await checkFiles(env.ctx, dylan, { paths: ['src/a.ts'] })).conflicts).toEqual([]);
    expect(await recordClaimOverride(env.ctx, dylan, { paths: ['src/a.ts'] })).toEqual({ owners: [] });
    expect((await getActivity(env.ctx, ronit)).filter((e) => e.type === 'claim_overridden')).toEqual([]);
    expect(await readInbox(env.ctx, zed)).toEqual([]);
  });

  it('breaks ties on one path by agent name', async () => {
    const { ash, dylan, ronit } = await seedTeam(env);
    await claimFiles(env.ctx, ash, { globs: ['src/**'] });
    // two agents whose non-overlapping globs both match one path via a broad pattern
    await env.ctx.db.insertInto('claims').values({
      id: 'zz-claim', team_id: ronit.teamId, agent_id: dylan.id, glob: '**/a.ts', exclusive: 1,
      expires_at: '2027-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
    }).execute();
    const res = await checkFiles(env.ctx, ronit, { paths: ['src/a.ts'] });
    expect(res.conflicts.map((c) => c.agent)).toEqual(['ash-codex', 'dylan-claude']);
  });
});
