import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestContext, seedTeam, type TestEnv } from './helpers.js';
import { claimFiles, globsOverlap, releaseFiles, whoOwns } from '../src/services/claims.js';
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
