import { execFileSync } from 'node:child_process';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitTeamClient } from '../../src/git/client.js';
import { newAgentKeyPair } from '../../src/git/crypto.js';
import { encodeMeta } from '../../src/git/meta.js';
import { writeMeta } from '../../src/git/refs.js';
import { listPending } from '../../src/git/replicaStore.js';
import { pinTeamMetaFromInvite, syncRound } from '../../src/git/sync.js';
import { teamCreatorOf } from '../../src/git/view.js';
import { TEAM, bootstrap, deps, dump, git, makeWorld, ownSeqs, remoteHead, view, type Agent, type World } from './syncHelpers.js';

let world: World;
beforeEach(() => { world = makeWorld(); });
afterEach(async () => { await world.cleanup(); });

const client = (a: Agent) => new GitTeamClient(deps, a.cred, { trigger: () => undefined });
const sync = (a: Agent, opts = {}) => syncRound(deps, a.repo, a.cred, opts);
const bodies = async (a: Agent) => (await client(a).ping(false)).messages.map((m) => m.body);
const offline = (a: Agent): Agent => ({ ...a, cred: { ...a.cred, git: { ...a.cred.git!, remote: join(world.tmp, 'gone.git') } } });
const stateOf = async (who: Agent, agent: string) => (await (await view(who)).files.readLogState()).agents[agent];
const gitIn = (cwd: string, args: string[], input?: string) => execFileSync('git', args, { cwd, input, encoding: 'utf8' }).trim();

async function twoAgents(): Promise<{ lead: Agent; worker: Agent }> {
  const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
  expect((await sync(lead)).ok).toBe(true);
  const worker = await bootstrap(world, world.clone('b'), 'join', 'bob');
  expect((await sync(worker)).ok).toBe(true);
  expect((await sync(lead)).ok).toBe(true);
  return { lead, worker };
}

/** An attacker clone with the agent's remote ref fetched as refs/x. */
function attacker(agentId: string): string {
  const evil = world.clone(`evil-${Math.random().toString(36).slice(2, 8)}`);
  git(evil, 'fetch', '-q', world.remote, `+refs/agentteams/${TEAM}/agents/${agentId}:refs/x`);
  return evil;
}

const pushTo = (evil: string, commit: string, agentId: string) =>
  git(evil, 'push', '-q', '--force', world.remote, `${commit}:refs/agentteams/${TEAM}/agents/${agentId}`);

describe('N1: only provably-own commits move an agent head', () => {
  it('an empty commit is refused, and the victim\'s later restore is accepted', async () => {
    const { lead, worker } = await twoAgents();
    // The lead writes while offline: committed locally, not pushed.
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'written offline' });
    expect((await sync(offline(lead))).published).toBe(1);
    const before = await stateOf(worker, lead.id);
    // An attacker puts an empty commit on the lead's remote tip.
    const evil = attacker(lead.id);
    const empty = git(evil, 'commit-tree', git(evil, 'rev-parse', 'refs/x^{tree}'), '-p', 'refs/x', '-m', 'empty');
    pushTo(evil, empty, lead.id);
    const s = await sync(worker);
    expect(s.problems.join('\n')).toMatch(/changes nothing; refused/);
    expect((await stateOf(worker, lead.id))!.head).toBe(before!.head);
    // The lead comes back: its chain is restored over the vandalism, and the worker accepts it.
    expect((await sync(lead)).restored).toBe(true);
    const s2 = await sync(worker);
    expect(s2.problems).toEqual([]);
    expect(await bodies(worker)).toContain('written offline');
  });

  it('a replayed old presence blob is refused', async () => {
    const { lead, worker } = await twoAgents();
    const t0 = Date.now();
    await sync(lead, { now: () => t0 + 120_000 }); // a newer presence on top of the first one
    await sync(worker);
    const evil = attacker(lead.id);
    // The oldest presence blob in the lead's history, put back on top.
    const firstWithPresence = gitIn(evil, ['log', '--format=%H', '--reverse', 'refs/x', '--', 'presence.bin']).split('\n')[0]!;
    const oldBlob = git(evil, 'rev-parse', `${firstWithPresence}:presence.bin`);
    const tree = gitIn(evil, ['mktree'], gitIn(evil, ['ls-tree', 'refs/x']).split('\n')
      .map((l) => (l.endsWith('\tpresence.bin') ? `100644 blob ${oldBlob}\tpresence.bin` : l)).join('\n') + '\n');
    pushTo(evil, git(evil, 'commit-tree', tree, '-p', 'refs/x', '-m', 'replay'), lead.id);
    const s = await sync(worker);
    expect(s.problems.join('\n')).toMatch(/presence is not newer than the last one/);
  });
});

describe('N2: an inflated own ref never stops its owner', () => {
  it('a commit with a huge tree on our own remote ref is treated as vandalism and restored', async () => {
    const { lead, worker } = await twoAgents();
    const evil = attacker(lead.id);
    const blob = gitIn(evil, ['hash-object', '-w', '--stdin'], 'x');
    const entries = Array.from({ length: 50_000 }, (_, i) => `100644 blob ${blob}\tf${String(i).padStart(6, '0')}`).join('\n');
    const ops = gitIn(evil, ['mktree'], `${entries}\n`);
    const tree = gitIn(evil, ['mktree'], `${gitIn(evil, ['ls-tree', 'refs/x'])}\n040000 tree ${ops}\tjunk\n`);
    pushTo(evil, git(evil, 'commit-tree', tree, '-p', 'refs/x', '-m', 'huge'), lead.id);
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'still here' });
    const s = await sync(lead);
    expect(s.ok).toBe(true);
    expect(s.restored).toBe(true);
    expect(s.published).toBe(1);
    expect((await sync(lead)).ok).toBe(true);
    const w = await sync(worker);
    expect(w.problems).toEqual([]);
    expect(await bodies(worker)).toContain('still here');
  });
});

describe('N3: a paused round cannot corrupt the own log', () => {
  it('a round that resumes after losing its lease aborts on the compare-and-swap; the log stays valid', async () => {
    const { lead, worker } = await twoAgents();
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'exactly once' });
    const v = await view(lead);
    let other: Awaited<ReturnType<typeof sync>> | undefined;
    const a = await sync(lead, {
      onPhase: async () => {
        // Round A is "paused" past its lease: its lock goes stale and round B runs to completion.
        const old = new Date(Date.now() - 60_000);
        utimesSync(v.paths.lock, old, old);
        other = await sync(lead);
      },
    });
    expect(other!.ok).toBe(true);
    expect(other!.published).toBe(1);
    expect(a.ok).toBe(false);
    expect(a.errors.join('\n')).toMatch(/moved unexpectedly/);
    const seqs = ownSeqs(lead.repo, lead.id);
    const c = await sync(lead);
    expect(c.ok).toBe(true);
    expect(c.problems).toEqual([]);
    expect(c.published).toBe(0);
    expect(ownSeqs(lead.repo, lead.id)).toEqual(seqs);
    expect(await listPending(v.store.ctx.db, lead.id)).toEqual([]);
    await sync(worker);
    expect((await bodies(worker)).filter((b) => b === 'exactly once')).toHaveLength(1);
    expect(remoteHead(world, lead.id)).toBe(git(lead.repo, 'rev-parse', `refs/agentteams-local/${TEAM}/agents/${lead.id}`));
  });
});

describe('N4: the creator repairs a vandalised team meta', () => {
  async function forgeMeta(kind: 'forged' | 'garbage'): Promise<void> {
    const evil = world.clone(`evil-${kind}`);
    if (kind === 'forged') {
      const keys = newAgentKeyPair();
      await writeMeta(deps, evil, TEAM, encodeMeta({
        teamId: TEAM, name: 'x', createdAt: new Date().toISOString(), defaultBranch: 'main',
        agentId: '01JZZZZZZZZZZZZZZZZZZZZZZZ', publicKey: keys.publicKey,
      }, world.teamKey, keys.privateKey));
    } else {
      await writeMeta(deps, evil, TEAM, Buffer.from('garbage'));
    }
    git(evil, 'push', '-q', '--force', world.remote, `refs/agentteams-local/${TEAM}/meta:refs/agentteams/${TEAM}/meta`);
  }

  for (const kind of ['forged', 'garbage'] as const) {
    it(`a ${kind} meta is refused by replicas and restored by the creator before a new joiner arrives`, async () => {
      const { lead, worker } = await twoAgents();
      await forgeMeta(kind);
      const w = await sync(worker);
      expect(w.problems.join('\n')).toMatch(kind === 'forged' ? /names creator 01JZZ.*not the pinned one/ : /team meta \(remote\) does not verify/);
      const l = await sync(lead);
      expect(l.metaRestored).toBe(true);
      // A new joiner now sees the real meta and converges.
      const carl = await bootstrap(world, world.clone('carl'), 'join', 'carl');
      expect((await sync(carl)).problems).toEqual([]);
      expect(await teamCreatorOf(await view(carl))).toEqual({ agentId: lead.id, publicKey: lead.cred.git!.publicKey });
      await sync(lead);
      await sync(worker);
      await sync(carl);
      expect(await dump(carl)).toBe(await dump(lead));
    });
  }

  it('a joiner that pinned the creator from the invite refuses a forged meta even on first sight', async () => {
    const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
    await sync(lead);
    await forgeMeta('forged');
    const carl = await bootstrap(world, world.clone('carl'), 'join', 'carl');
    await pinTeamMetaFromInvite((await view(carl)).store, TEAM, { agentId: lead.id, publicKey: lead.cred.git!.publicKey });
    const s = await sync(carl);
    expect(s.problems.join('\n')).toMatch(/not the pinned one/);
    expect(await teamCreatorOf(await view(carl))).toEqual({ agentId: lead.id, publicKey: lead.cred.git!.publicKey });
  });
});

describe('L2: git-derived error text', () => {
  it('is labelled, flattened, stripped of control characters and truncated', async () => {
    const { cleanError } = await import('../../src/git/sync.js');
    const out = cleanError(new Error(`git log failed: \x01abc\nremote: ‮evil\u0007 ${'x'.repeat(500)}`));
    expect(out.startsWith('log (from git): ')).toBe(true);
    expect(out).not.toMatch(/[\x00-\x1f‮]/);
    expect(out.length).toBeLessThanOrEqual('log (from git): '.length + 200);
  });
});
