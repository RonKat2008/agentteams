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
});
