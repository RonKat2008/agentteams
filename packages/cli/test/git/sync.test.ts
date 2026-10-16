import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitTeamClient } from '../../src/git/client.js';
import { pinStoreFor } from '../../src/git/compat.js';
import { newAgentKeyPair } from '../../src/git/crypto.js';
import { createHlc } from '../../src/git/hlc.js';
import { captureOp } from '../../src/git/ops.js';
import { appendSegment, pushOwn } from '../../src/git/refs.js';
import { rebuildView } from '../../src/git/replay.js';
import { MAX_SEGMENT_BYTES, encodeSegment } from '../../src/git/segment.js';
import { syncRound } from '../../src/git/sync.js';
import { acquireLock, readStatus, takeSyncWarning } from '../../src/git/syncState.js';
import { opSource } from '../../src/git/view.js';
import { HubError } from '../../src/hubClient.js';
import { TEAM, bootstrap, deps, dump, git, makeWorld, view, type Agent, type World } from './syncHelpers.js';

let world: World;
beforeEach(() => { world = makeWorld(); });
afterEach(async () => { await world.cleanup(); });

const noSync = () => undefined;
const client = (a: Agent, trigger: () => void = noSync) => new GitTeamClient(deps, a.cred, { trigger });
const sync = (a: Agent, opts = {}) => syncRound(deps, a.repo, a.cred, opts);

/** Lead creates the team in clone a; worker joins from clone b. Both synced. */
async function twoAgents(): Promise<{ lead: Agent; worker: Agent }> {
  const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
  expect((await sync(lead)).ok).toBe(true);
  const worker = await bootstrap(world, world.clone('b'), 'join', 'bob');
  expect((await sync(worker)).ok).toBe(true);
  expect((await sync(lead)).ok).toBe(true);
  return { lead, worker };
}

describe('sync round', () => {
  it('two clones exchange ops and converge to identical views', async () => {
    const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
    expect((await sync(lead)).ok).toBe(true);
    const worker = await bootstrap(world, world.clone('b'), 'join', 'bob');
    const w1 = await sync(worker);
    expect(w1.ok).toBe(true);
    expect(w1.pushed).toBe(true);
    expect((await sync(lead)).ok).toBe(true);

    const leadClient = client(lead);
    const task = await leadClient.execute('createTask', { title: 'Write docs', assignee: worker.name }) as { number: number };
    await leadClient.execute('sendMessage', { to: worker.name, kind: 'fyi', body: 'hello bob' });
    expect((await sync(lead)).pushed).toBe(true);
    expect((await sync(worker)).ok).toBe(true);

    const workerClient = client(worker);
    const inbox = await workerClient.ping(true);
    expect(inbox.messages.map((m) => m.body)).toContain('hello bob');
    expect((await workerClient.claimTask(task.number)).status).toBe('in_progress');
    expect((await workerClient.ping(false)).messages).toEqual([]);
    await sync(worker);
    await sync(lead);
    await sync(worker);
    expect(await dump(lead)).toBe(await dump(worker));
    expect((await leadClient.getTask(task.number)).status).toBe('in_progress');
  });

  it('a GitTeamClient write is visible at once locally and on the other clone after a sync', async () => {
    const { lead, worker } = await twoAgents();
    const triggers: string[] = [];
    const c = client(lead, () => triggers.push('sync'));
    await c.execute('sendMessage', { to: 'all', kind: 'fyi', body: 'now' });
    expect(triggers).toEqual(['sync']);
    const { store } = await view(lead);
    const rows = await store.ctx.db.selectFrom('messages').select('body').execute();
    expect(rows.map((r) => r.body)).toContain('now');
    expect((await client(worker).ping(false)).messages.map((m) => m.body)).not.toContain('now');
    await sync(lead);
    await sync(worker);
    expect((await client(worker).ping(false)).messages.map((m) => m.body)).toContain('now');
  });

  it('a call that changes nothing is not logged and rejected calls throw without being stored', async () => {
    const { lead, worker } = await twoAgents();
    const c = client(worker);
    await expect(c.execute('createTask', { title: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    const v = await view(worker);
    expect(await v.files.listPending()).toEqual([]);
    const r = await c.execute('releaseFiles', {}) as { released: number };
    expect(r.released).toBe(0);
    expect(await v.files.listPending()).toEqual([]);
    void lead;
  });

  it('a pending op survives a crash between persist and push', async () => {
    const { lead, worker } = await twoAgents();
    const v = await view(lead);
    // Crash right after persisting: the op was never applied or pushed.
    const op = captureOp(createHlc(), lead.id, 'sendMessage', { to: 'all', kind: 'fyi', body: 'survivor' });
    await v.files.persistPending(op);
    const s = await sync(lead);
    expect(s.ok).toBe(true);
    expect(s.published).toBe(1);
    expect(await v.files.listPending()).toEqual([]);
    await sync(worker);
    expect((await client(worker).ping(false)).messages.map((m) => m.body)).toContain('survivor');
    expect((await client(lead).status()).agents.length).toBe(2);
  });

  it('the lock prevents overlapping rounds, and a stale lock is broken', async () => {
    const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
    const v = await view(lead);
    const held = await acquireLock(v.paths.lock);
    expect(held).not.toBeNull();
    expect(await sync(lead)).toMatchObject({ ok: false, skipped: 'locked' });
    await held!.release();

    writeFileSync(v.paths.lock, '{"pid":1,"token":"dead"}\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(v.paths.lock, old, old);
    const s = await sync(lead);
    expect(s.skipped).toBeUndefined();
    expect(s.ok).toBe(true);
  });

  it('an unreachable remote returns an error, keeps the ops, logs and warns once', async () => {
    const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann', { remote: join(world.tmp, 'missing.git') });
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'queued' });
    const s = await sync(lead);
    expect(s.ok).toBe(false);
    expect(s.errors[0]).toMatch(/^fetch:/);
    const v = await view(lead);
    // Published into the local log, waiting for a push.
    expect(s.published).toBe(1);
    expect(git(lead.repo, 'rev-parse', `refs/agentteams-local/${TEAM}/agents/${lead.id}`)).toMatch(/^[0-9a-f]{40}/);
    const status = await readStatus(v.paths);
    expect(status.lastError).toMatch(/fetch/);
    expect(status.lastFetchAt).toBeUndefined();
    expect(readFileSync(v.paths.log, 'utf8')).toMatch(/fetch:/);
    const warning = await takeSyncWarning(deps, lead.repo);
    expect(warning).toMatch(/^agentteams: sync failed: fetch: .* \(see \.git\/agentteams\/sync\.log\)$/);
    expect(await takeSyncWarning(deps, lead.repo)).toBeNull();
    // Point it at the real remote: the queued op goes out.
    const fixed = { ...lead, cred: { ...lead.cred, git: { ...lead.cred.git!, remote: world.remote } } };
    expect((await sync(fixed)).pushed).toBe(true);
    expect(git(world.remote, 'for-each-ref', `refs/agentteams/${TEAM}/agents/`)).toContain(lead.id);
  });

  it('rejects a non-fast-forward rewrite of another agent ref and keeps the old chain', async () => {
    const { lead, worker } = await twoAgents();
    await client(lead).execute('sendMessage', { to: 'all', kind: 'fyi', body: 'original' });
    await sync(lead);
    await sync(worker);
    // Someone with push access rewrites the lead's ref with an unrelated history.
    const evil = world.clone('evil');
    const tree = git(evil, 'mktree');
    const commit = git(evil, 'commit-tree', tree, '-m', 'rewrite');
    git(evil, 'push', '-q', '--force', world.remote, `${commit}:refs/agentteams/${TEAM}/agents/${lead.id}`);
    const s = await sync(worker);
    expect(s.problems.join('\n')).toMatch(/non-fast-forward rewrite/);
    expect((await client(worker).ping(false)).messages.map((m) => m.body)).toContain('original');
    const state = await (await view(worker)).files.readLogState();
    expect(state.agents[lead.id]!.head).not.toBe(commit);
    expect(readFileSync((await view(worker)).paths.log, 'utf8')).toMatch(/non-fast-forward/);
  });

  it('a seq gap halts ingestion for that agent until filled', async () => {
    const { lead, worker } = await twoAgents();
    const hlc = createHlc();
    const op1 = captureOp(hlc, lead.id, 'sendMessage', { to: 'all', kind: 'fyi', body: 'one' });
    const op2 = captureOp(hlc, lead.id, 'sendMessage', { to: 'all', kind: 'fyi', body: 'two' });
    const enc = (seq: number, op: typeof op1) => encodeSegment({ teamId: TEAM, agent: lead.id, seq, ops: [op] }, world.teamKey, lead.cred.git!.privateKey);
    await appendSegment(deps, lead.repo, TEAM, lead.id, 2, enc(2, op2));
    expect((await pushOwn(deps, lead.repo, world.remote, TEAM, lead.id)).ok).toBe(true);
    const s = await sync(worker);
    expect(s.problems.join('\n')).toMatch(/seq 1 is missing/);
    expect((await client(worker).ping(false)).messages.map((m) => m.body)).not.toContain('two');
    await appendSegment(deps, lead.repo, TEAM, lead.id, 1, enc(1, op1));
    expect((await pushOwn(deps, lead.repo, world.remote, TEAM, lead.id)).ok).toBe(true);
    const s2 = await sync(worker);
    expect(s2.problems).toEqual([]);
    expect((await client(worker).ping(false)).messages.map((m) => m.body)).toEqual(expect.arrayContaining(['one', 'two']));
  });

  it('rejects an oversized blob without reading it', async () => {
    const { lead, worker } = await twoAgents();
    await appendSegment(deps, lead.repo, TEAM, lead.id, 1, Buffer.alloc(MAX_SEGMENT_BYTES + 1, 7));
    expect((await pushOwn(deps, lead.repo, world.remote, TEAM, lead.id)).ok).toBe(true);
    const s = await sync(worker);
    expect(s.problems.join('\n')).toMatch(/seq 1: \d+ bytes exceeds the segment limit/);
    expect((await (await view(worker)).files.readLogState()).agents[lead.id]!.nextSeq).toBe(1);
  });

  it('rejects a seq-0 segment whose key differs from the pinned key', async () => {
    const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
    await sync(lead);
    const worker = await bootstrap(world, world.clone('b'), 'join', 'bob');
    // The worker's replica already pinned a different key for the lead's agent id.
    expect(await pinStoreFor((await view(worker)).files).pin(lead.id, newAgentKeyPair().publicKey)).toBe('pinned');
    const s = await sync(worker);
    expect(s.problems.join('\n')).toMatch(new RegExp(`agent ${lead.id} seq 0: bootstrap key differs from the pinned key`));
    const { store } = await view(worker);
    expect(await store.ctx.db.selectFrom('teams').select('id').execute()).toEqual([]);
    // The pin is never replaced.
    expect(await pinStoreFor((await view(worker)).files).get(lead.id)).not.toBe(lead.cred.git!.publicKey);
  });

  it('presence sets last_seen_at, and is re-applied after a rebuild', async () => {
    const { lead, worker } = await twoAgents();
    const later = Date.now() + 120_000;
    await sync(lead, { now: () => later });
    await sync(worker, { now: () => later });
    const { store, files } = await view(worker);
    const seen = async () => (await store.ctx.db.selectFrom('agents').select('last_seen_at').where('id', '=', lead.id).executeTakeFirstOrThrow()).last_seen_at;
    expect(await seen()).toBe(new Date(later).toISOString());
    await rebuildView(store, { source: opSource(files), teamId: TEAM, localAgentId: worker.id });
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
