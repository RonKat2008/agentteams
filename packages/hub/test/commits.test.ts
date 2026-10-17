import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestContext, seedTeam, type TestEnv } from './helpers.js';
import { getChanges, recordCommit } from '../src/services/commits.js';
import { claimFiles } from '../src/services/claims.js';
import { readInbox } from '../src/services/messages.js';
import { getActivity } from '../src/services/activity.js';

let env: TestEnv;
beforeEach(async () => { env = await makeTestContext(); });
afterEach(async () => { await env.close(); });

const commit = (over: Partial<{ sha: string; files: string[]; message: string; branch: string }> = {}) => ({
  sha: 'abc1234def', branch: 'at/ash-codex/1', message: 'Add OAuth callback\n\nlonger body',
  files: ['src/auth/callback.ts'], insertions: 40, deletions: 2, ...over,
});

describe('recordCommit', () => {
  it('logs a commit event with the subject line and counts only', async () => {
    const { ash, ronit } = await seedTeam(env);
    await recordCommit(env.ctx, ash, commit());
    const event = (await getActivity(env.ctx, ronit)).at(-1)!;
    expect(event).toMatchObject({
      type: 'commit', agent: 'ash-codex',
      data: { sha: 'abc1234def', branch: 'at/ash-codex/1', subject: 'Add OAuth callback', files: 1, insertions: 40, deletions: 2 },
    });
  });

  it('tells agents whose claims cover the changed files, but not the committer or bystanders', async () => {
    const { ash, dylan, ronit } = await seedTeam(env);
    await claimFiles(env.ctx, dylan, { globs: ['src/auth/**'], exclusive: false });
    await claimFiles(env.ctx, ash, { globs: ['src/auth/callback.ts'], exclusive: false });
    const res = await recordCommit(env.ctx, ash, commit());
    expect(res.notified).toEqual(['dylan-claude']);
    expect(await readInbox(env.ctx, dylan)).toEqual([
      expect.objectContaining({ kind: 'fyi', from: 'ash-codex', body: expect.stringContaining('src/auth/callback.ts') }),
    ]);
    expect(await readInbox(env.ctx, ronit)).toEqual([]);
    expect(await readInbox(env.ctx, ash)).toEqual([]);
  });

  it('sends one notice to an agent whose several claims match, and skips non-matching claims', async () => {
    const { ash, dylan, ronit } = await seedTeam(env);
    await claimFiles(env.ctx, dylan, { globs: ['src/**'], exclusive: false });
    await claimFiles(env.ctx, dylan, { globs: ['src/auth/**'], exclusive: false });
    await claimFiles(env.ctx, ronit, { globs: ['docs/**'], exclusive: false });
    const res = await recordCommit(env.ctx, ash, commit());
    expect(res.notified).toEqual(['dylan-claude']);
    expect(await readInbox(env.ctx, dylan)).toHaveLength(1);
    expect(await readInbox(env.ctx, ronit)).toEqual([]);
  });

  it('truncates the file list in the notice to 10 names', async () => {
    const { ash, dylan } = await seedTeam(env);
    await claimFiles(env.ctx, dylan, { globs: ['src/**'], exclusive: false });
    const files = Array.from({ length: 12 }, (_, i) => `src/file${String(i + 1).padStart(2, '0')}.ts`);
    await recordCommit(env.ctx, ash, commit({ files }));
    const [msg] = await readInbox(env.ctx, dylan);
    expect(msg!.body).toContain('src/file10.ts');
    expect(msg!.body).toContain('and 2 more');
    expect(msg!.body).not.toContain('src/file11.ts');
  });

  it('rejects malformed input', async () => {
    const { ash } = await seedTeam(env);
    await expect(recordCommit(env.ctx, ash, commit({ sha: 'not-a-sha' }))).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('getChanges', () => {
  it('returns newest first and filters by agent', async () => {
    const { ash, dylan } = await seedTeam(env);
    await recordCommit(env.ctx, ash, commit({ sha: 'aaaaaaa' }));
    await recordCommit(env.ctx, dylan, commit({ sha: 'bbbbbbb', branch: 'at/dylan-claude/2' }));
    expect((await getChanges(env.ctx, ash)).map((c) => c.sha)).toEqual(['bbbbbbb', 'aaaaaaa']);
    const mine = await getChanges(env.ctx, ash, { agent: 'ash-codex' });
    expect(mine).toEqual([expect.objectContaining({ sha: 'aaaaaaa', agent: 'ash-codex', files: ['src/auth/callback.ts'] })]);
  });

  it('filters by since, normalising non-millisecond timestamps', async () => {
    const { ash } = await seedTeam(env);
    await recordCommit(env.ctx, ash, commit({ sha: 'aaaaaaa' }));
    env.advance(500);
    await recordCommit(env.ctx, ash, commit({ sha: 'bbbbbbb' }));
    const recent = await getChanges(env.ctx, ash, { since: '2026-01-01T00:00:00Z' });
    expect(recent.map((c) => c.sha)).toEqual(['bbbbbbb']);
  });
});

describe('recordCommit dedupe', () => {
  it('treats a repeated sha+branch as a no-op duplicate', async () => {
    const { ash, dylan, ronit } = await seedTeam(env);
    await claimFiles(env.ctx, dylan, { globs: ['src/auth/**'], exclusive: false });
    const first = await recordCommit(env.ctx, ash, commit());
    const second = await recordCommit(env.ctx, ash, commit());
    expect(first).toEqual({ notified: ['dylan-claude'], duplicate: false });
    expect(second).toEqual({ notified: [], duplicate: true });
    expect((await getActivity(env.ctx, ronit)).filter((e) => e.type === 'commit')).toHaveLength(1);
    expect(await readInbox(env.ctx, dylan)).toHaveLength(1);
    expect(await getChanges(env.ctx, ronit)).toHaveLength(1);
  });

  it('keeps each agent record of the same sha and branch (credit cannot be taken over)', async () => {
    const { ash, dylan, ronit } = await seedTeam(env);
    expect((await recordCommit(env.ctx, dylan, commit({ message: 'decoy' }))).duplicate).toBe(false);
    expect((await recordCommit(env.ctx, ash, commit())).duplicate).toBe(false);
    expect((await recordCommit(env.ctx, ash, commit())).duplicate).toBe(true);
    expect((await getChanges(env.ctx, ronit)).map((c) => [c.agent, c.message]).sort())
      .toEqual([['ash-codex', commit().message], ['dylan-claude', 'decoy']].sort());
  });

  it('records the same sha on a different branch', async () => {
    const { ash } = await seedTeam(env);
    await recordCommit(env.ctx, ash, commit());
    expect((await recordCommit(env.ctx, ash, commit({ branch: 'other' }))).duplicate).toBe(false);
  });
});

describe('recordCommit concurrency', () => {
  it('lets exactly one of two concurrent identical commits through', async () => {
    const { ash, dylan, ronit } = await seedTeam(env);
    await claimFiles(env.ctx, dylan, { globs: ['src/auth/**'], exclusive: false });
    const results = await Promise.all([recordCommit(env.ctx, ash, commit()), recordCommit(env.ctx, ash, commit())]);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    expect((await getActivity(env.ctx, ronit)).filter((e) => e.type === 'commit')).toHaveLength(1);
    expect(await readInbox(env.ctx, dylan)).toHaveLength(1);
  });
});
