import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitTeamClient } from '../../src/git/client.js';
import { newAgentKeyPair } from '../../src/git/crypto.js';
import { encodeMeta } from '../../src/git/meta.js';
import { createHlc } from '../../src/git/hlc.js';
import { captureOp } from '../../src/git/ops.js';
import { appendSegment, writeMeta } from '../../src/git/refs.js';
import { encodeSegment } from '../../src/git/segment.js';
import { listPending } from '../../src/git/replicaStore.js';
import { pinTeamMetaFromInvite, syncRound } from '../../src/git/sync.js';
import { teamCreatorOf } from '../../src/git/view.js';
import {
  TEAM, appendMany, bootstrap, deps, dump, git, makeWorld, ownSeqs, remoteHead, view, type Agent, type World,
} from './syncHelpers.js';

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

describe('R1: commit identity is irrelevant; replicas read content by path', () => {
  it('a re-created commit (new sha, same content) changes nothing: no refusal, and later writes flow', async () => {
    const { lead, worker } = await twoAgents();
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'm1' });
    expect((await sync(lead)).pushed).toBe(true);
    // The attacker re-creates the lead's tip: same tree, same parent, different sha (another author and date).
    const evil = attacker(lead.id);
    const parent = gitIn(evil, ['rev-list', '--max-count=1', '--skip=1', 'refs/x']);
    const fake = gitIn(evil, ['commit-tree', git(evil, 'rev-parse', 'refs/x^{tree}'), ...(parent ? ['-p', parent] : []), '-m', 'recreated']);
    expect(fake).not.toBe(remoteHead(world, lead.id));
    pushTo(evil, fake, lead.id);
    const w1 = await sync(worker);
    expect(w1.problems).toEqual([]);
    expect(await bodies(worker)).toContain('m1');
    const l1 = await sync(lead);
    expect(l1.problems).toEqual([]);
    expect(l1.restored).toBe(false); // same content: nothing to restore
    // The lead keeps writing on top of the re-created commit (leased push); the worker reads on, never refusing.
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'm2' });
    expect((await sync(lead)).pushed).toBe(true);
    const w2 = await sync(worker);
    expect(w2.problems).toEqual([]);
    expect(await bodies(worker)).toContain('m2');
  });

  it('a whole chain re-created as one root commit does not fork a new joiner', async () => {
    const { lead, worker } = await twoAgents();
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'm1' });
    await sync(lead);
    const evil = attacker(lead.id);
    pushTo(evil, gitIn(evil, ['commit-tree', git(evil, 'rev-parse', 'refs/x^{tree}'), '-m', 'recreated root']), lead.id);
    const carl = await bootstrap(world, world.clone('carl'), 'join', 'carl');
    expect((await sync(carl)).problems).toEqual([]);
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'm2' });
    await sync(lead);
    expect((await sync(carl)).problems).toEqual([]);
    expect((await sync(worker)).problems).toEqual([]);
    expect(await bodies(carl)).toContain('m2');
    expect(await bodies(worker)).toContain('m2');
    await sync(lead);
    expect(await dump(carl)).toBe(await dump(lead));
    expect(await dump(worker)).toBe(await dump(lead));
  });

  it('a re-created commit with junk content is refused as data, never as the agent: its later writes are accepted', async () => {
    const { lead, worker } = await twoAgents();
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'm1' });
    await sync(lead);
    await sync(worker);
    const n = ownSeqs(lead.repo, lead.id).length;
    const accepted = (await stateOf(worker, lead.id))!;
    // Junk over the last accepted seq, junk as the next seq, and a junk presence.
    const evil = attacker(lead.id);
    const junk = gitIn(evil, ['hash-object', '-w', '--stdin'], 'junk');
    const shard = gitIn(evil, ['ls-tree', 'refs/x:ops/00000']).split('\n')
      .map((l) => (l.endsWith(`\t${String(n - 1).padStart(8, '0')}.bin`) ? l.replace(/[0-9a-f]{40}/, junk) : l));
    shard.push(`100644 blob ${junk}\t${String(n).padStart(8, '0')}.bin`);
    const shardTree = gitIn(evil, ['mktree'], `${shard.join('\n')}\n`);
    const ops = gitIn(evil, ['mktree'], `040000 tree ${shardTree}\t00000\n`);
    const root = gitIn(evil, ['mktree'], `040000 tree ${ops}\tops\n100644 blob ${junk}\tpresence.bin\n`);
    pushTo(evil, gitIn(evil, ['commit-tree', root, '-m', 'junk']), lead.id);
    const w1 = await sync(worker);
    const text = w1.problems.join('\n');
    expect(text).toMatch(new RegExp(`agent ${lead.id}: seq ${n - 1} was replaced with data that does not verify; ignored`));
    expect(text).toMatch(new RegExp(`agent ${lead.id}: seq ${n} does not verify \\(decrypt\\); refused`));
    expect(text).toMatch(/presence does not verify; ignored/);
    expect((await stateOf(worker, lead.id))!.nextSeq).toBe(accepted.nextSeq);
    expect(await bodies(worker)).toContain('m1');
    // The lead restores its log and writes on; the same paths now hold valid data and are accepted.
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'm2' });
    const l = await sync(lead);
    expect(l.restored).toBe(true);
    const w2 = await sync(worker);
    expect(w2.problems).toEqual([]);
    expect(await bodies(worker)).toContain('m2');
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

describe('equivocation: a second, different segment signed for an accepted seq', () => {
  it('is logged and ignored by replicas; the agent itself refuses to push over it', async () => {
    const { lead, worker } = await twoAgents();
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'first' });
    await sync(lead);
    await sync(worker);
    const n = ownSeqs(lead.repo, lead.id).length;
    // Someone holding the lead's key (another clone of its credential) signs different content for seq n-1.
    const evil = attacker(lead.id);
    const op = captureOp(createHlc(), lead.id, 'sendMessage', { to: 'all', kind: 'fyi', body: 'second' }, { idOf: () => undefined });
    await appendSegment(deps, evil, TEAM, lead.id, n - 1,
      encodeSegment({ teamId: TEAM, agent: lead.id, seq: n - 1, ops: [op] }, world.teamKey, lead.cred.git!.privateKey));
    git(evil, 'push', '-q', '--force', world.remote, `refs/agentteams-local/${TEAM}/agents/${lead.id}:refs/agentteams/${TEAM}/agents/${lead.id}`);
    const w = await sync(worker);
    expect(w.problems.join('\n')).toMatch(new RegExp(`agent ${lead.id}: equivocation: seq ${n - 1} exists with different content signed by this agent; keeping the first copy`));
    expect(await bodies(worker)).toContain('first');
    expect(await bodies(worker)).not.toContain('second');
    const l = await sync(lead);
    expect(l.ok).toBe(false);
    expect(l.errors.join('\n')).toMatch(new RegExp(`different seq ${n - 1} signed with this agent's key .*not pushing`));
    expect(l.pushed).toBe(false);
  });
});

describe('tree guards: oversized log trees are skipped before any path lookup', () => {
  for (const kind of ['ops', 'root'] as const) {
    it(`an oversized ${kind} tree on an agent ref is skipped with a warning; the owner restores it`, async () => {
      const { lead, worker } = await twoAgents();
      const evil = attacker(lead.id);
      const blob = gitIn(evil, ['hash-object', '-w', '--stdin'], 'x');
      const many = (count: number) => Array.from({ length: count }, (_, i) => `100644 blob ${blob}\tf${String(i).padStart(6, '0')}`).join('\n');
      const root = kind === 'ops'
        ? gitIn(evil, ['mktree'], `040000 tree ${gitIn(evil, ['mktree'], `${many(130_000)}\n`)}\tops\n`)
        : gitIn(evil, ['mktree'], `${gitIn(evil, ['ls-tree', 'refs/x'])}\n${many(150)}\n`);
      pushTo(evil, gitIn(evil, ['commit-tree', root, '-m', 'huge']), lead.id);
      const w = await sync(worker);
      expect(w.problems.join('\n')).toMatch(new RegExp(`agent ${lead.id}: the log tree is oversized \\(${kind} \\d+ bytes, limit \\d+\\); skipped until its log changes`));
      expect(w.ok).toBe(true);
      await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'after the flood' });
      const l = await sync(lead);
      expect(l.restored).toBe(true);
      expect(l.problems.join('\n')).toMatch(/our own log on the remote is not usable \(the log tree is oversized/);
      const w2 = await sync(worker);
      expect(w2.problems).toEqual([]);
      expect(await bodies(worker)).toContain('after the flood');
    });
  }
});

describe('own-log check cost', () => {
  it('a flood of shard directories just under the ops limit is restored without listing each of them', async () => {
    const { lead, worker } = await twoAgents();
    const evil = attacker(lead.id);
    const empty = gitIn(evil, ['mktree'], '');
    const shards = Array.from({ length: 100_000 }, (_, i) => `040000 tree ${empty}\t${String(i + 1).padStart(5, '0')}`).join('\n');
    const ops = gitIn(evil, ['mktree', '--missing'], `${shards}\n`);
    pushTo(evil, gitIn(evil, ['commit-tree', gitIn(evil, ['mktree'], `040000 tree ${ops}\tops\n`), '-m', 'flood']), lead.id);
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'after the shard flood' });
    const t0 = Date.now();
    const l = await sync(lead);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(l.ok).toBe(true);
    expect(l.restored).toBe(true);
    await sync(worker);
    expect((await stateOf(worker, lead.id))!.nextSeq).toBe(ownSeqs(lead.repo, lead.id).length);
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

  it('L4: a re-cloned creator (no local meta) repairs the meta from its pin and its key', async () => {
    const { lead, worker } = await twoAgents();
    const a2 = world.clone('a2');
    const lead2: Agent = { ...lead, repo: a2, cred: { ...lead.cred, repoPath: a2 } };
    expect((await sync(lead2)).ok).toBe(true); // pins the (still good) meta in the new clone
    expect(git(a2, 'for-each-ref', `refs/agentteams-local/${TEAM}/meta`)).toBe('');
    await forgeMeta('garbage');
    expect((await sync(worker)).problems.join('\n')).toMatch(/team meta \(remote\) does not verify/);
    const l = await sync(lead2);
    expect(l.metaRestored).toBe(true);
    const carl = await bootstrap(world, world.clone('carl'), 'join', 'carl');
    expect((await sync(carl)).problems).toEqual([]);
    expect(await teamCreatorOf(await view(carl))).toEqual({ agentId: lead.id, publicKey: lead.cred.git!.publicKey });
    expect((await sync(worker)).problems).toEqual([]);
  });

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

describe('R2: a re-cloned agent adopts its own remote log at any depth', () => {
  it('an agent with more than 600 segments re-clones: its remote log is not truncated and it keeps publishing', async () => {
    const { lead, worker } = await twoAgents();
    await appendMany(world, lead, ownSeqs(lead.repo, lead.id).length, 610);
    expect((await sync(lead)).pushed).toBe(true);
    for (let i = 0; i < 5 && (await sync(worker)).morePending; i++) { /* drain the backlog */ }
    expect((await stateOf(worker, lead.id))!.nextSeq).toBe(611);
    const remoteSeqs = () => gitIn(world.remote, ['ls-tree', '-r', '--name-only', `refs/agentteams/${TEAM}/agents/${lead.id}:ops`]).split('\n').length;
    expect(remoteSeqs()).toBe(611);
    // The same credential in a fresh clone (credentials live in ~/.agentteams).
    const a2 = world.clone('a2');
    const lead2: Agent = { ...lead, repo: a2, cred: { ...lead.cred, repoPath: a2 } };
    const r1 = await sync(lead2);
    expect(r1.ok).toBe(true);
    expect(r1.errors).toEqual([]);
    expect(r1.problems).toEqual([]);
    expect(ownSeqs(a2, lead.id)).toHaveLength(611);
    expect(remoteSeqs()).toBe(611);
    await client(lead2).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'from the re-clone' });
    const r2 = await sync(lead2);
    expect(r2.ok).toBe(true);
    expect(r2.published).toBe(1);
    expect(remoteSeqs()).toBe(612);
    const w = await sync(worker);
    expect(w.problems).toEqual([]);
    expect((await stateOf(worker, lead.id))!.nextSeq).toBe(612);
    const db = (await view(worker)).store.ctx.db;
    expect(await db.selectFrom('messages').select('body').where('body', '=', 'from the re-clone').execute()).toHaveLength(1);
  });
});

describe('R3: presence never goes backwards for its writer', () => {
  it('the clock moves back after sync-status.json is lost: the agent keeps publishing and its presence stays newer', async () => {
    const { lead, worker } = await twoAgents();
    const t0 = Date.now();
    expect((await sync(lead, { now: () => t0 + 600_000 })).ok).toBe(true);
    const before = (await stateOf(lead, lead.id))!.presence!;
    expect(before.ts).toBe(t0 + 600_000);
    rmSync((await view(lead)).paths.status);
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'after the clock jump' });
    const s = await sync(lead, { now: () => t0 + 300_000 });
    expect(s.ok).toBe(true);
    expect(s.errors).toEqual([]);
    expect(s.published).toBe(1);
    expect(s.pushed).toBe(true);
    const after = (await stateOf(lead, lead.id))!.presence!;
    expect(after.ts).toBe(before.ts);
    expect(after.counter).toBe(before.counter + 1);
    const w = await sync(worker);
    expect(w.problems).toEqual([]);
    expect(await bodies(worker)).toContain('after the clock jump');
    expect((await stateOf(worker, lead.id))!.presence!.counter).toBe(after.counter);
  });
});

describe('R4: a round is bounded whatever the number of agents and writes', () => {
  it('many agents with many segments: each round stays within the budget, round-robin, and everything converges', async () => {
    const { lead, worker } = await twoAgents();
    const agents: Agent[] = [lead];
    for (const m of ['cat', 'dan', 'eve', 'fay']) agents.push(await bootstrap(world, world.clone(m), 'join', m));
    for (const a of agents) {
      await appendMany(world, a, ownSeqs(a.repo, a.id).length, 20);
      expect((await sync(a)).ok).toBe(true);
    }
    const budget = { segments: 12, presence: 2 };
    const progress = async () => Promise.all(agents.map(async (a) => (await stateOf(worker, a.id))?.nextSeq ?? 0));
    const start = await progress();
    const first = await sync(worker, { budget });
    // Every round reads at most 12 segments (one op each) and visits at most 2 remote agents.
    expect(first.rounds).toBe(4);
    expect(first.ingested).toBeLessThanOrEqual(12 * first.rounds);
    expect(first.morePending).toBe(true);
    expect(existsSync((await view(worker)).paths.pending)).toBe(true); // the next detached sync continues
    // Round-robin: no agent starves (the visits rotate).
    const afterFirst = await progress();
    expect(afterFirst.filter((n, i) => n > start[i]!).length).toBeGreaterThanOrEqual(4);
    let calls = 1;
    for (let s = first; s.morePending; calls++) s = await sync(worker, { budget });
    expect(calls).toBeLessThan(10);
    expect(await progress()).toEqual(agents.map(() => 21));
    for (const a of agents) await sync(a);
    await sync(worker);
    expect(await dump(worker)).toBe(await dump(lead));
  });

  it('presence writes alone are budgeted as agent visits', async () => {
    const { lead, worker } = await twoAgents();
    const cat = await bootstrap(world, world.clone('cat'), 'join', 'cat');
    await sync(cat);
    await sync(worker);
    const later = Date.now() + 120_000;
    await sync(lead, { now: () => later });
    await sync(cat, { now: () => later });
    const s = await sync(worker, { budget: { segments: 64, presence: 1 } });
    expect(s.rounds).toBe(2); // one visit per round: the second agent's presence is read in the queued round
    expect((await stateOf(worker, lead.id))!.presence!.ts).toBe(later);
    expect((await stateOf(worker, cat.id))!.presence!.ts).toBe(later);
  });
});
