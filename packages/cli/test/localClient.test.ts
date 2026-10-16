import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HubError } from '../src/hubClient.js';
import { LocalTeamClient } from '../src/local/localClient.js';
import { openTeamStore, teamDbPath } from '../src/local/store.js';
import { teamClientFor } from '../src/teamClient.js';
import { git, gitDeps, makeRepo, seedTeam, type Seeded, type TempRepo } from './localHelpers.js';

let r: TempRepo;
let s: Seeded;
let alice: LocalTeamClient;
let bob: LocalTeamClient;

async function send(from: Seeded['alice'], to: string, body: string): Promise<void> {
  const { ctx, core } = await openTeamStore(gitDeps, r.repo);
  const actor = await core.authenticate(ctx, from.apiKey);
  const { sendMessage } = await import('../../hub/src/services/messages.js');
  await sendMessage(ctx, actor, { to, body, kind: 'fyi' });
}

beforeAll(async () => {
  r = makeRepo();
  s = await seedTeam(r.repo);
  alice = new LocalTeamClient(gitDeps, s.alice);
  bob = new LocalTeamClient(gitDeps, s.bob);
});
afterAll(() => r.cleanup());

describe('store', () => {
  it('lives under the git common dir with private permissions', async () => {
    const path = await teamDbPath(gitDeps, r.repo);
    expect(path).toBe(join(r.repo, '.git', 'agentteams', 'team.db'));
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(r.repo, '.git', 'agentteams')).mode & 0o777).toBe(0o700);
  });

  it('resolves the same database from a linked worktree', async () => {
    const wt = join(r.root, 'wt');
    git(r.repo, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
    expect(await teamDbPath(gitDeps, wt)).toBe(await teamDbPath(gitDeps, r.repo));
    const viaWorktree = new LocalTeamClient(gitDeps, { ...s.alice, repoPath: wt });
    expect((await viaWorktree.status()).team.name).toBe('Acme');
  });

  it('fails clearly outside a git repo', async () => {
    await expect(teamDbPath(gitDeps, r.root)).rejects.toThrow(/not a git repository/);
  });
});

describe('factory', () => {
  it('returns a LocalTeamClient for transport local', () => {
    expect(teamClientFor({ fetch: globalThis.fetch, exec: gitDeps.exec }, s.alice)).toBeInstanceOf(LocalTeamClient);
  });
});

describe('LocalTeamClient', () => {
  it('maps domain errors to HubError with HTTP-like status', async () => {
    const bad = new LocalTeamClient(gitDeps, { ...s.alice, apiKey: 'at_nope' });
    const err = await bad.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubError);
    expect(err).toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('status lists both agents and the orchestrator', async () => {
    const st = await alice.status();
    expect(st.team).toMatchObject({ name: 'Acme', orchestrator: s.alice.agentName });
    expect(st.agents.map((a) => a.name).sort()).toEqual([s.alice.agentName, s.bob.agentName].sort());
  });

  it('ping returns the agent name and an empty inbox when nothing is pending', async () => {
    expect(await bob.ping()).toEqual({ agent: s.bob.agentName, messages: [] });
  });

  it('two agents exchange a message; it is delivered once, then marked read', async () => {
    await send(s.alice, s.bob.agentName, 'hello bob');
    expect((await bob.ping(false)).messages.map((m) => m.body)).toEqual(['hello bob']);
    expect((await bob.ping(false)).messages).toHaveLength(1); // peeking does not consume
    expect((await bob.ping(true)).messages.map((m) => m.body)).toEqual(['hello bob']);
    expect((await bob.ping(true)).messages).toEqual([]);
  });

  it('ping limit delivers and marks read only that many of the oldest messages', async () => {
    for (const body of ['one', 'two', 'three']) await send(s.alice, s.bob.agentName, body);
    expect((await bob.ping(true, 2)).messages.map((m) => m.body)).toEqual(['one', 'two']);
    expect((await bob.ping(true)).messages.map((m) => m.body)).toEqual(['three']);
  });

  it('rejects an invalid task number like the HTTP route does', async () => {
    for (const n of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
      await expect(alice.getTask(n)).rejects.toMatchObject({ code: 'invalid', status: 400 });
      await expect(alice.claimTask(n)).rejects.toMatchObject({ code: 'invalid', status: 400 });
      await expect(alice.completeTask(n, 's', 'b')).rejects.toMatchObject({ code: 'invalid', status: 400 });
      await expect(alice.markMerged(n)).rejects.toMatchObject({ code: 'invalid', status: 400 });
    }
  });

  it('maps unexpected errors to a generic internal error, and SQLITE_BUSY to a retryable conflict', async () => {
    const { ctx } = await openTeamStore(gitDeps, r.repo);
    const original = ctx.db.selectFrom.bind(ctx.db);
    const boom = (e: Error) => { (ctx.db as { selectFrom: unknown }).selectFrom = () => { throw e; }; };
    try {
      boom(new Error('secret path /tmp/x exploded'));
      await expect(alice.status()).rejects.toMatchObject({ code: 'internal', message: 'internal error', status: 500 });
      boom(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));
      await expect(alice.status()).rejects.toMatchObject({ code: 'conflict', status: 409, message: expect.stringContaining('retry') });
    } finally {
      (ctx.db as { selectFrom: unknown }).selectFrom = original;
    }
  });

  it('activity returns events, honouring limit', async () => {
    const all = await alice.activity();
    expect(all.length).toBeGreaterThan(0);
    expect(await alice.activity({ limit: 1 })).toHaveLength(1);
    expect(await alice.activity({ since: '2999-01-01T00:00:00.000Z' })).toEqual([]);
  });

  it('setOrchestrator, rotateInvite, revokeInvite', async () => {
    expect(await alice.setOrchestrator(s.bob.agentName)).toEqual({ orchestrator: s.bob.agentName });
    expect(await alice.setOrchestrator(s.alice.agentName)).toEqual({ orchestrator: s.alice.agentName });
    const rotated = await alice.rotateInvite();
    expect(rotated.inviteCode).toBeTruthy();
    expect(rotated.inviteCode).not.toBe(s.inviteCode);
    expect(await alice.revokeInvite()).toEqual({ revoked: true });
  });

  it('checkFiles / claimOverride', async () => {
    const res = await alice.checkFiles(['src/x.ts']);
    expect(res).toBeDefined();
    const ov = await bob.claimOverride(['src/x.ts']);
    expect(Array.isArray(ov.owners)).toBe(true);
  });

  it('recordCommit is idempotent by sha', async () => {
    const input = { sha: 'abcdef1234567', branch: 'main', message: 'x', files: ['a.txt'], insertions: 1, deletions: 0 };
    const first = await alice.recordCommit(input);
    expect(first.duplicate).toBe(false);
    expect((await alice.recordCommit(input)).duplicate).toBe(true);
  });

  it('task lifecycle: get, claim, complete, merge', async () => {
    const { openTeamStore } = await import('../src/local/store.js');
    const { ctx, core } = await openTeamStore(gitDeps, r.repo);
    const actor = await core.authenticate(ctx, s.alice.apiKey);
    const { createTask } = await import('../../hub/src/services/tasks.js');
    const t = await createTask(ctx, actor, { title: 'Do it', description: '' });
    expect((await bob.getTask(t.number)).title).toBe('Do it');
    expect((await bob.claimTask(t.number)).status).toBe('in_progress');
    expect((await bob.completeTask(t.number, 'done', 'feat/x')).status).toBe('done');
    expect((await alice.markMerged(t.number, 'https://example.com/pr/1')).mergedAt).toBeTruthy();
    await expect(alice.getTask(999)).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
});
