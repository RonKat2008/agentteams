import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitTeamClient } from '../../src/git/client.js';
import { newAgentKeyPair } from '../../src/git/crypto.js';
import { createHlc } from '../../src/git/hlc.js';
import { captureOp } from '../../src/git/ops.js';
import { appendSegment, pushOwn } from '../../src/git/refs.js';
import { listPending } from '../../src/git/replicaStore.js';
import { getPinnedKey, loadAgentDirectory, pinAgentKey, rebuildView } from '../../src/git/replay.js';
import { MAX_SEGMENT_BYTES, encodeSegment } from '../../src/git/segment.js';
import { syncRound } from '../../src/git/sync.js';
import { acquireLock, readStatus, takeSyncWarnings } from '../../src/git/syncState.js';
import { replayTarget, teamCreatorOf } from '../../src/git/view.js';
import { HubError } from '../../src/hubClient.js';
import {
  TEAM, bootstrap, deps, dump, forgeOnRemote, git, makeWorld, ownSeqs, remoteHead, view, type Agent, type World,
} from './syncHelpers.js';

let world: World;
beforeEach(() => { world = makeWorld(); });
afterEach(async () => { await world.cleanup(); });

const noSync = () => undefined;
const client = (a: Agent, trigger: () => void = noSync) => new GitTeamClient(deps, a.cred, { trigger });
const sync = (a: Agent, opts = {}) => syncRound(deps, a.repo, a.cred, opts);
const bodies = async (a: Agent) => (await client(a).ping(false)).messages.map((m) => m.body);
const pending = async (a: Agent) => listPending((await view(a)).store.ctx.db, a.id);

/** Lead creates the team in clone a; worker joins from clone b. Both synced. */
async function twoAgents(): Promise<{ lead: Agent; worker: Agent }> {
  const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
  expect((await sync(lead)).ok).toBe(true);
  const worker = await bootstrap(world, world.clone('b'), 'join', 'bob');
  expect((await sync(worker)).ok).toBe(true);
  expect((await sync(lead)).ok).toBe(true);
  return { lead, worker };
}

/** A segment signed by `a` (as if written by its own CLI). */
function segmentOf(a: Agent, seq: number, body: string): Buffer {
  const op = captureOp(createHlc(), a.id, 'sendMessage', { to: 'all', kind: 'fyi', body }, { idOf: () => undefined });
  return encodeSegment({ teamId: TEAM, agent: a.id, seq, ops: [op] }, world.teamKey, a.cred.git!.privateKey);
}

describe('sync round', () => {
  it('two clones exchange ops and converge to identical views', async () => {
    const { lead, worker } = await twoAgents();
    const leadClient = client(lead);
    const task = await leadClient.execute('createTask', { title: 'Write docs', assignee: worker.name }) as { number: number };
    await leadClient.execute('sendMessage', { to: worker.name, kind: 'fyi', body: 'hello bob' });
    expect((await sync(lead)).pushed).toBe(true);
    expect((await sync(worker)).ok).toBe(true);

    const workerClient = client(worker);
    expect((await workerClient.ping(true)).messages.map((m) => m.body)).toContain('hello bob');
    expect((await workerClient.claimTask(task.number)).status).toBe('in_progress');
    expect((await workerClient.ping(false)).messages).toEqual([]);
    await sync(worker);
    await sync(lead);
    await sync(worker);
    expect(await dump(lead)).toBe(await dump(worker));
    expect((await leadClient.getTask(task.number)).status).toBe('in_progress');
  });

  it('a write is applied and queued atomically, visible at once, and seen by the other clone after a sync', async () => {
    const { lead, worker } = await twoAgents();
    const triggers: string[] = [];
    await client(lead, () => triggers.push('sync')).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'now' });
    expect(triggers).toEqual(['sync']);
    expect((await pending(lead)).map((o) => o.op)).toEqual(['sendMessage']);
    const { store } = await view(lead);
    expect((await store.ctx.db.selectFrom('messages').select('body').execute()).map((r) => r.body)).toContain('now');
    expect(await bodies(worker)).not.toContain('now');
    await sync(lead);
    expect(await pending(lead)).toEqual([]);
    await sync(worker);
    expect(await bodies(worker)).toContain('now');
  });

  it('a rejected call stores nothing and a no-op call is not logged', async () => {
    const { worker } = await twoAgents();
    const c = client(worker);
    await expect(c.execute('createTask', { title: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(c.execute('sendMessage', { to: 'nobody-claude', kind: 'fyi', body: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await pending(worker)).toEqual([]);
    expect(await c.execute('releaseFiles', {})).toEqual({ released: 0 });
    expect(await pending(worker)).toEqual([]);
  });

  it('a queued op survives a crash before the push (and legacy pending files are migrated once)', async () => {
    const { lead, worker } = await twoAgents();
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'survivor' });
    // A pending file left by the first Task 7 layout.
    const v = await view(lead);
    const legacy = captureOp(createHlc(), lead.id, 'sendMessage', { to: 'all', kind: 'fyi', body: 'legacy' }, await loadAgentDirectory(v.store, TEAM));
    mkdirSync(join(v.files.dir, 'pending'), { recursive: true });
    writeFileSync(join(v.files.dir, 'pending', `${legacy.id}.json`), JSON.stringify(legacy));
    const s = await sync(lead);
    expect(s.ok).toBe(true);
    expect(s.published).toBe(2);
    expect(existsSync(join(v.files.dir, 'pending', `${legacy.id}.json`))).toBe(false);
    await sync(worker);
    expect(await bodies(worker)).toEqual(expect.arrayContaining(['survivor', 'legacy']));
  });

  it('a crash after appendSegment and before pending removal never publishes an op twice', async () => {
    const { lead, worker } = await twoAgents();
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'once' });
    const [op] = await pending(lead);
    const seqsBefore = ownSeqs(lead.repo, lead.id);
    // The crash: the op is in our log, but still pending.
    await appendSegment(deps, lead.repo, TEAM, lead.id, seqsBefore.length,
      encodeSegment({ teamId: TEAM, agent: lead.id, seq: seqsBefore.length, ops: [op!] }, world.teamKey, lead.cred.git!.privateKey));
    const s = await sync(lead);
    expect(s.published).toBe(0);
    expect(ownSeqs(lead.repo, lead.id).length).toBe(seqsBefore.length + 1);
    expect(await pending(lead)).toEqual([]);
    await sync(worker);
    expect((await bodies(worker)).filter((b) => b === 'once')).toHaveLength(1);
  });

  it('the lock prevents overlapping rounds; a stale lock is broken; detached syncs coalesce', async () => {
    const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
    const v = await view(lead);
    const held = await acquireLock(v.paths.lock);
    expect(held).not.toBeNull();
    expect(await sync(lead)).toMatchObject({ ok: false, skipped: 'locked' });
    expect(await sync(lead, { coalesce: true })).toMatchObject({ skipped: 'queued' });
    expect(existsSync(v.paths.pending)).toBe(true);
    await held!.release();
    // The marker makes the next lock holder run an extra round and consume it.
    const s0 = await sync(lead);
    expect(s0.ok).toBe(true);
    expect(existsSync(v.paths.pending)).toBe(false);

    writeFileSync(v.paths.lock, '{"pid":1,"token":"dead"}\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(v.paths.lock, old, old);
    const s = await sync(lead);
    expect(s.skipped).toBeUndefined();
    expect(s.ok).toBe(true);
    expect(existsSync(v.paths.lock)).toBe(false);
  });

  it('a round that loses its lock stops before writing', async () => {
    const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
    const v = await view(lead);
    const lock = await acquireLock(v.paths.lock);
    writeFileSync(v.paths.lock, '{"pid":1,"token":"someone-else"}\n');
    await expect(lock!.assertOwned()).rejects.toThrow(/taken over/);
    await lock!.release();
    expect(readFileSync(v.paths.lock, 'utf8')).toContain('someone-else'); // never removes a lock it does not own
  });

  it('an unreachable remote returns an error, keeps the ops, logs and warns once', async () => {
    const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann', { remote: join(world.tmp, 'missing.git') });
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'queued' });
    const s = await sync(lead);
    expect(s.ok).toBe(false);
    expect(s.errors[0]).toMatch(/^fetch \(from git\): /);
    expect(s.published).toBe(1);
    const v = await view(lead);
    const status = await readStatus(v.paths);
    expect(status.lastError).toMatch(/^fetch \(from git\)/);
    expect(status.lastFetchAt).toBeUndefined();
    expect(readFileSync(v.paths.log, 'utf8')).toMatch(/fetch \(from git\)/);
    const warnings = await takeSyncWarnings(deps, lead.repo);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^agentteams: sync failed: fetch \(from git\): .{1,200} \(see \.git\/agentteams\/sync\.log\)$/);
    expect(await takeSyncWarnings(deps, lead.repo)).toEqual([]);
    const fixed = { ...lead, cred: { ...lead.cred, git: { ...lead.cred.git!, remote: world.remote } } };
    expect((await sync(fixed)).pushed).toBe(true);
    expect(git(world.remote, 'for-each-ref', `refs/agentteams/${TEAM}/agents/`)).toContain(lead.id);
    // After a clean round the same error would be shown again.
    await sync(lead);
    expect(await takeSyncWarnings(deps, lead.repo)).toHaveLength(1);
  });

  it('refuses a non-fast-forward rewrite of another agent ref, keeps the chain and warns once', async () => {
    const { lead, worker } = await twoAgents();
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'original' });
    await sync(lead);
    await sync(worker);
    const evil = world.clone('evil');
    const commit = git(evil, 'commit-tree', git(evil, 'mktree'), '-m', 'rewrite');
    git(evil, 'push', '-q', '--force', world.remote, `${commit}:refs/agentteams/${TEAM}/agents/${lead.id}`);
    const s = await sync(worker);
    expect(s.problems.join('\n')).toMatch(/non-fast-forward rewrite/);
    expect(await bodies(worker)).toContain('original');
    expect((await (await view(worker)).files.readLogState()).agents[lead.id]!.head).not.toBe(commit);
    const w = await takeSyncWarnings(deps, worker.repo);
    expect(w.join('\n')).toMatch(/agentteams: security: refused team data: .*non-fast-forward/);
    expect(await takeSyncWarnings(deps, worker.repo)).toEqual([]);
  });

  it('probe 1: a forged commit on our own remote ref is not adopted; our log is restored and keeps flowing', async () => {
    const { lead, worker } = await twoAgents();
    const seqs = ownSeqs(lead.repo, lead.id).length;
    const forged = await forgeOnRemote(world, lead.id, seqs, Buffer.from('junk'));
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'after vandalism' });
    const s = await sync(lead);
    expect(s.problems.join('\n')).toMatch(/our own log on the remote was altered/);
    expect(s.restored).toBe(true);
    expect(s.published).toBe(1);
    expect(ownSeqs(lead.repo, lead.id).length).toBe(seqs + 1); // no junk adopted, no loop
    expect(await pending(lead)).toEqual([]);
    expect(remoteHead(world, lead.id)).not.toBe(forged);
    expect((await sync(lead)).published).toBe(0);
    const w = await sync(worker);
    expect(w.problems).toEqual([]);
    expect(await bodies(worker)).toContain('after vandalism');
  });

  it('probe 2: a forged fast-forward on another agent ref is refused, and the later restore is accepted', async () => {
    const { lead, worker } = await twoAgents();
    const acceptedHead = (await (await view(worker)).files.readLogState()).agents[lead.id]!.head;
    const forged = await forgeOnRemote(world, lead.id, ownSeqs(lead.repo, lead.id).length, Buffer.from('junk'));
    const s = await sync(worker);
    expect(s.problems.join('\n')).toMatch(/rejected \(decrypt\); refused/);
    const state = (await (await view(worker)).files.readLogState()).agents[lead.id]!;
    expect(state.head).not.toBe(forged);
    expect(state.head).toBe(acceptedHead);
    // The lead restores its chain (ruling C5) and keeps writing: the worker accepts it as a fast-forward.
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'restored' });
    expect((await sync(lead)).restored).toBe(true);
    const s2 = await sync(worker);
    expect(s2.problems).toEqual([]);
    expect(await bodies(worker)).toContain('restored');
  });

  it('a seq gap halts ingestion for that agent until filled', async () => {
    const { lead, worker } = await twoAgents();
    const n = ownSeqs(lead.repo, lead.id).length;
    await appendSegment(deps, lead.repo, TEAM, lead.id, n + 1, segmentOf(lead, n + 1, 'two'));
    expect((await pushOwn(deps, lead.repo, world.remote, TEAM, lead.id)).ok).toBe(true);
    const s = await sync(worker);
    expect(s.problems.join('\n')).toMatch(new RegExp(`seq ${n} is missing`));
    expect(await bodies(worker)).not.toContain('two');
    await appendSegment(deps, lead.repo, TEAM, lead.id, n, segmentOf(lead, n, 'one'));
    expect((await pushOwn(deps, lead.repo, world.remote, TEAM, lead.id)).ok).toBe(true);
    const s2 = await sync(worker);
    expect(s2.problems).toEqual([]);
    expect(await bodies(worker)).toEqual(expect.arrayContaining(['one', 'two']));
  });

  it('refuses an oversized blob without reading it', async () => {
    const { lead, worker } = await twoAgents();
    const n = ownSeqs(lead.repo, lead.id).length;
    await forgeOnRemote(world, lead.id, n, Buffer.alloc(MAX_SEGMENT_BYTES + 1, 7));
    const s = await sync(worker);
    expect(s.problems.join('\n')).toMatch(new RegExp(`seq ${n}: \\d+ bytes exceeds the segment limit`));
    expect((await (await view(worker)).files.readLogState()).agents[lead.id]!.nextSeq).toBe(n);
  });

  it('a huge or garbage ref never stops our own publish and push; backlogs drain 32 segments per round', async () => {
    const { lead, worker } = await twoAgents();
    // Garbage: a commit that adds a non-segment file on the lead's ref.
    const evil = world.clone('evil');
    git(evil, 'fetch', '-q', world.remote, `+refs/agentteams/${TEAM}/agents/${lead.id}:refs/x`);
    const blob = execGit(evil, ['hash-object', '-w', '--stdin'], 'garbage');
    const tree = execGit(evil, ['mktree'], `${git(evil, 'ls-tree', 'refs/x')}\n100644 blob ${blob}\tnot-a-segment\n`);
    const c = git(evil, 'commit-tree', tree, '-p', 'refs/x', '-m', 'garbage');
    git(evil, 'push', '-q', world.remote, `${c}:refs/agentteams/${TEAM}/agents/${lead.id}`);
    await client(worker).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'still flowing' });
    const s = await sync(worker);
    expect(s.problems.join('\n')).toMatch(/adds not-a-segment; refused/);
    expect(s.pushed).toBe(true);
    expect(s.published).toBe(1);

    // An honest backlog of 40 segments from a third agent reaches the worker over two rounds.
    const third = await bootstrap(world, world.clone('c'), 'join', 'cat');
    for (let i = 1; i <= 40; i++) await appendSegment(deps, third.repo, TEAM, third.id, i, segmentOf(third, i, `m${i}`));
    expect((await sync(third)).ok).toBe(true);
    const r1 = await sync(worker);
    expect((await (await view(worker)).files.readLogState()).agents[third.id]!.nextSeq).toBe(32);
    expect(r1.problems.filter((p) => p.includes(third.id))).toEqual([]);
    await sync(worker);
    expect((await (await view(worker)).files.readLogState()).agents[third.id]!.nextSeq).toBe(41);
  });

  it('refuses a seq-0 segment whose key differs from the pinned key', async () => {
    const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
    await sync(lead);
    const worker = await bootstrap(world, world.clone('b'), 'join', 'bob');
    const v = await view(worker);
    const other = newAgentKeyPair().publicKey;
    expect(await pinAgentKey(v.store, lead.id, other)).toBe('pinned');
    const s = await sync(worker);
    expect(s.problems.join('\n')).toMatch(new RegExp(`agent ${lead.id} seq 0: bootstrap key differs from the pinned key`));
    expect(await getPinnedKey(v.store, lead.id)).toBe(other);
  });

  it('verifies and pins the team meta; a different meta is refused', async () => {
    const { lead, worker } = await twoAgents();
    const v = await view(worker);
    expect(await teamCreatorOf(v)).toEqual({ agentId: lead.id, publicKey: lead.cred.git!.publicKey });
    // Someone rewrites the remote meta with one naming themselves as creator.
    const { encodeMeta } = await import('../../src/git/meta.js');
    const { writeMeta } = await import('../../src/git/refs.js');
    const keys = newAgentKeyPair();
    const evil = world.clone('evil');
    await writeMeta(deps, evil, TEAM, encodeMeta({
      teamId: TEAM, name: 'x', createdAt: new Date().toISOString(), defaultBranch: 'main', agentId: '01JZZZZZZZZZZZZZZZZZZZZZZZ', publicKey: keys.publicKey,
    }, world.teamKey, keys.privateKey));
    git(evil, 'push', '-q', '--force', world.remote, `refs/agentteams-local/${TEAM}/meta:refs/agentteams/${TEAM}/meta`);
    const s = await sync(worker);
    expect(s.problems.join('\n')).toMatch(/team meta \(remote\) names creator 01JZZZZZZZZZZZZZZZZZZZZZZZ, not the pinned one/);
    expect(await teamCreatorOf(v)).toEqual({ agentId: lead.id, publicKey: lead.cred.git!.publicKey });
  });

  it('two agents of one clone read each other from local refs without refusals', async () => {
    const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
    await sync(lead);
    const codex = await bootstrap(world, lead.repo, 'join', 'ann', { tool: 'codex' });
    await client(codex).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'from codex' });
    // codex has not pushed; the claude agent's round must not call codex's local log a rewrite.
    const s = await sync(lead);
    expect(s.problems).toEqual([]);
    expect(s.ok).toBe(true);
    expect((await sync(codex)).problems).toEqual([]);
    expect((await sync(lead)).problems).toEqual([]);
  });

  it('presence sets last_seen_at, and is re-applied after a rebuild', async () => {
    const { lead, worker } = await twoAgents();
    const later = Date.now() + 120_000;
    await sync(lead, { now: () => later });
    await sync(worker, { now: () => later });
    const v = await view(worker);
    const seen = async () => (await v.store.ctx.db.selectFrom('agents').select('last_seen_at').where('id', '=', lead.id).executeTakeFirstOrThrow()).last_seen_at;
    expect(await seen()).toBe(new Date(later).toISOString());
    const { store, source } = replayTarget(v);
    await rebuildView(store, { source, teamId: TEAM, localAgentId: worker.id, teamCreator: (await teamCreatorOf(v))! });
    expect(await seen()).not.toBe(new Date(later).toISOString());
    await sync(worker, { now: () => later });
    expect(await seen()).toBe(new Date(later).toISOString());
  });

  it('refuses invite rotation for git teams', async () => {
    const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
    await expect(client(lead).rotateInvite()).rejects.toBeInstanceOf(HubError);
    await expect(client(lead).revokeInvite()).rejects.toThrow(/controlled by the team repo/);
  });
});

function execGit(cwd: string, args: string[], input: string): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8' }).trim();
}
