import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as core from '@agentteams/hub/core';
import { newAgentKeyPair } from '../../src/git/crypto.js';
import { createHlc, formatHlc } from '../../src/git/hlc.js';
import { captureBootstrapOp, captureOp, mintOpId } from '../../src/git/ops.js';
import { rebuildView, takeNotices } from '../../src/git/replay.js';
import type { Op } from '../../src/git/segment.js';
import { Scenario, TEAM_ID, batches, openReplica, prng, shuffle, type Replica, type ScenarioAgent } from './replayHelpers.js';

const open: Replica[] = [];
async function replica(source: () => unknown[], localAgentId?: string): Promise<Replica> {
  const r = await openReplica(source, localAgentId);
  open.push(r);
  return r;
}
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

interface Built {
  s: Scenario;
  ops: Op[];
  ronit: ScenarioAgent;
  dylan: ScenarioAgent;
  ash: ScenarioAgent;
  kai: ScenarioAgent;
  claimByDylan: Op;
  claimByKai: Op;
  rejectedCreate: Op;
}

/** A realistic log: team create, 3 joins, tasks, direct and broadcast messages, reads, claims, commits, conflicts. */
async function buildLog(): Promise<Built> {
  const s = await Scenario.start();
  const ronit = await s.createTeam('ronit');
  s.tick();
  const dylan = await s.join('dylan');
  s.tick(5);
  const ash = await s.join('ash', 'codex');
  s.tick();
  await s.op(ronit, 'sendMessage', { to: 'all', body: 'welcome, early birds', kind: 'fyi' });
  s.tick();
  const kai = await s.join('kai', 'cursor');
  s.tick();
  await s.op(ronit, 'createTask', { title: 'Build the parser', description: 'src/a', assignee: 'dylan-claude' });
  await s.op(ronit, 'createTask', { title: 'Write docs' }); // same ms: HLC counter 1
  s.tick();
  await s.op(dylan, 'claimTask', { task: 1 });
  await s.op(dylan, 'claimFiles', { globs: ['src/a/**'] });
  s.tick();
  await s.op(ash, 'claimFiles', { globs: ['src/a/x.ts'] }); // conflicts: not granted, no change
  await s.op(ash, 'sendMessage', { to: 'dylan-claude', body: 'need help with src/a?', kind: 'question' });
  s.tick();
  await s.op(dylan, 'markRead', { messageIds: await s.unread(dylan) });
  await s.op(dylan, 'recordCommit', {
    sha: 'aaaaaaa1', branch: 'task-1', message: 'parser: tokens', files: ['src/a/y.ts'], insertions: 10, deletions: 1,
  });
  s.tick();
  await s.op(ash, 'recordCommit', {
    sha: 'bbbbbbb2', branch: 'task-x', message: 'touch a', files: ['src/a/z.ts', 'README.md'], insertions: 2, deletions: 0,
  });
  await s.op(ash, 'recordClaimOverride', { paths: ['src/a/z.ts'], sha: 'bbbbbbb2' });
  s.tick();
  await s.op(dylan, 'updateTask', { task: 1, note: 'halfway', status: 'in_progress' });
  await s.op(dylan, 'completeTask', { task: 1, summary: 'parser done', branch: 'task-1' });
  s.tick();
  await s.op(ronit, 'markMerged', { task: 1, pr: 'https://example.com/pr/1' });
  await s.op(ronit, 'assignTask', { task: 2, assignee: 'ash-codex' });
  s.tick();
  await s.op(ash, 'claimTask', { task: 2 });
  await s.op(ronit, 'sendMessage', { to: 'all', body: 'standup in 5', kind: 'fyi' });
  s.tick();
  await s.op(kai, 'markRead', { messageIds: await s.unread(kai) });
  await s.op(dylan, 'releaseFiles', {});
  await s.op(ash, 'markRead', { messageIds: await s.unread(ash) });
  s.tick();
  await s.op(ronit, 'setOrchestrator', { agent: 'ash-codex' });
  s.tick();
  await s.op(ash, 'createTask', { title: 'Fix the flaky test' });
  s.tick();
  const rejectedCreate = await s.op(ronit, 'createTask', { title: 'not allowed any more' }); // no longer orchestrator
  s.tick();
  // Concurrent claims of task 3: neither author saw the other's op. Dylan's is earlier.
  const claimByDylan = await s.op(dylan, 'claimTask', { task: 3 });
  s.tick(3);
  const claimByKai = await s.op(kai, 'claimTask', { task: 3 }, { observe: false });
  s.tick();
  await s.op(ash, 'sendMessage', { to: 'all', body: 'thanks all', kind: 'fyi' });
  return { s, ops: [...s.ops], ronit, dylan, ash, kai, claimByDylan, claimByKai, rejectedCreate };
}

let log: Built;
let reference: string;
beforeAll(async () => {
  log = await buildLog();
  reference = await log.s.live.dump();
});

describe('applyOps determinism', () => {
  it('builds the expected view from the realistic log', async () => {
    const rows = await log.s.live.store.ctx.db.selectFrom('applied_ops').selectAll().execute();
    expect(rows).toHaveLength(log.ops.length);
    const rejected = rows.filter((r) => r.status === 'rejected').map((r) => r.op_id).sort();
    expect(rejected).toEqual([log.rejectedCreate.id, log.claimByKai.id].sort());
    const tasks = await log.s.live.store.ctx.db.selectFrom('tasks').selectAll().orderBy('number').execute();
    expect(tasks.map((t) => [t.number, t.status])).toEqual([[1, 'done'], [2, 'in_progress'], [3, 'in_progress']]);
    expect(tasks[0]!.merged_at).not.toBeNull();
    expect(tasks[2]!.assignee_agent_id).toBe(log.dylan.id);
    const reads = await log.s.live.store.ctx.db.selectFrom('message_reads').selectAll().execute();
    expect(reads.length).toBeGreaterThan(0);
  });

  it('produces a byte-identical view for every arrival order and batching, equal to a rebuild', async () => {
    const all = log.ops;
    const orders: Op[][][] = [
      [all], // one sorted batch
      [[...all].reverse()], // one batch, reverse arrival
      all.map((o) => [o]), // one op at a time, in order
      [...all].reverse().map((o) => [o]), // one at a time, reverse order (rebuild on almost every op)
    ];
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const rand = prng(seed);
      orders.push(batches(shuffle(all, rand), rand));
    }
    for (const order of orders) {
      let delivered: Op[] = [];
      const r = await replica(() => delivered);
      for (const batch of order) {
        delivered = [...delivered, ...batch];
        await r.apply(batch);
      }
      expect(await r.dump()).toBe(reference);
    }

    const rebuilt = await replica(() => all);
    const summary = await rebuildView(rebuilt.store, { source: { allOps: async () => all }, teamId: TEAM_ID });
    expect(summary).toMatchObject({ rebuilt: true, applied: all.length - 2, rejected: 2 });
    expect(await rebuilt.dump()).toBe(reference);
  });

  it('applies incrementally and rebuilds when a late op sorts before applied ones', async () => {
    const late = log.ops[8]!; // dylan's claimFiles: changes ash's later claim outcome
    const early = log.ops.filter((o) => o !== late);
    let delivered = early;
    const r = await replica(() => delivered);
    const first = await r.apply(early);
    expect(first.rebuilt).toBe(false);
    expect(await r.dump()).not.toBe(reference);

    delivered = log.ops;
    const second = await r.apply([late]);
    expect(second.rebuilt).toBe(true);
    expect(second.applied + second.rejected).toBe(log.ops.length);
    expect(await r.dump()).toBe(reference);

    // A further op that sorts last is incremental again.
    const tail = await r.apply([]);
    expect(tail).toEqual({ applied: 0, rejected: 0, duplicates: 0, rebuilt: false });
  });

  it('treats re-applying the same ops as a no-op', async () => {
    const r = await replica(() => log.ops);
    await r.apply(log.ops);
    const before = await r.dump();
    const again = await r.apply(shuffle(log.ops, prng(9)));
    expect(again).toEqual({ applied: 0, rejected: 0, duplicates: log.ops.length, rebuilt: false });
    expect(await r.dump()).toBe(before);
  });
});

describe('conflicts', () => {
  it('resolves concurrent claimTask the same way everywhere and notifies the loser', async () => {
    const forKai = await replica(() => log.ops, log.kai.id);
    const forDylan = await replica(() => log.ops, log.dylan.id);
    await forKai.apply(log.ops);
    // Dylan's machine sees its own claim, then kai's, out of order with everything else.
    await forDylan.apply(shuffle(log.ops, prng(42)));
    for (const r of [forKai, forDylan]) {
      const task = await r.store.ctx.db.selectFrom('tasks').selectAll().where('number', '=', 3).executeTakeFirstOrThrow();
      expect(task.assignee_agent_id).toBe(log.dylan.id);
      const row = await r.store.ctx.db.selectFrom('applied_ops').selectAll().where('op_id', '=', log.claimByKai.id).executeTakeFirstOrThrow();
      expect(row.status).toBe('rejected');
      expect(row.error).toContain('only the assignee (dylan-claude) can claim task #3');
    }
    expect(await forKai.dump()).toBe(await forDylan.dump());

    const notices = await takeNotices(forKai.store, log.kai.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.opId).toBe(log.claimByKai.id);
    expect(notices[0]!.body).toMatch(/Your claimTask .* was rejected .*dylan-claude/);
    expect(await takeNotices(forKai.store, log.kai.id)).toEqual([]); // delivered once
    expect(await takeNotices(forDylan.store, log.dylan.id)).toEqual([]);
  });

  it('keeps a notice across rebuilds without duplicating it, and withdraws it if the op later succeeds', async () => {
    const r = await replica(() => log.ops, log.kai.id);
    const withoutDylanClaim = log.ops.filter((o) => o !== log.claimByDylan);
    // Without dylan's earlier claim, kai's claim of task 3 succeeds.
    await r.apply(withoutDylanClaim);
    expect(await takeNoticesPeek(r, log.kai.id)).toEqual([]);
    // The late, earlier claim arrives: rebuild, kai's claim is now rejected.
    await r.apply([log.claimByDylan]);
    expect((await takeNoticesPeek(r, log.kai.id)).map((n) => n.op_id)).toEqual([log.claimByKai.id]);
    await rebuildView(r.store, { source: { allOps: async () => log.ops }, teamId: TEAM_ID, localAgentId: log.kai.id });
    expect((await takeNoticesPeek(r, log.kai.id)).map((n) => n.op_id)).toEqual([log.claimByKai.id]);
  });

  it('rejects an orchestrator-only op by a non-orchestrator', async () => {
    const r = await replica(() => log.ops);
    await r.apply(log.ops);
    const row = await r.store.ctx.db.selectFrom('applied_ops').selectAll().where('op_id', '=', log.rejectedCreate.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'rejected', error: 'forbidden: only the orchestrator (ash-codex) can create tasks' });
    const titles = (await r.store.ctx.db.selectFrom('tasks').select('title').execute()).map((t) => t.title);
    expect(titles).not.toContain('not allowed any more');
  });
});

async function takeNoticesPeek(r: Replica, agentId: string) {
  return r.store.ctx.db.selectFrom('replica_notices').selectAll().where('agent_id', '=', agentId).orderBy('op_id').execute();
}

describe('registration', () => {
  it('rejects a duplicate join with a different key (first registration wins), accepts the identical key', async () => {
    const s = await Scenario.start();
    open.push(s.live);
    await s.createTeam('ronit');
    s.tick();
    const dylan = await s.join('dylan');
    s.tick();
    const hlc = createHlc(() => s.now);
    hlc.observe(s.ops.at(-1)!.ts);
    const reJoin = (publicKey: string): Op => {
      const ts = hlc.tick();
      return {
        v: 1, id: mintOpId(ts), ts, agent: dylan.id, op: 'join',
        input: { teamId: TEAM_ID, member: 'dylan', tool: 'claude', agentId: dylan.id, agentName: 'dylan-claude', publicKey },
      };
    };
    const hijack = reJoin(newAgentKeyPair().publicKey);
    const same = reJoin(dylan.publicKey);
    await s.live.apply([hijack, same]);
    const rows = await s.live.store.ctx.db.selectFrom('applied_ops').selectAll().where('op_id', 'in', [hijack.id, same.id]).execute();
    const byId = new Map(rows.map((r) => [r.op_id, r]));
    expect(byId.get(hijack.id)).toMatchObject({ status: 'rejected', error: 'conflict: this agent is already registered with a different key' });
    expect(byId.get(same.id)).toMatchObject({ status: 'applied' });
    const key = await s.live.store.ctx.db.selectFrom('agent_keys').selectAll().where('agent_id', '=', dylan.id).executeTakeFirstOrThrow();
    expect(key.public_key).toBe(dylan.publicKey);
    expect(key.registered_op_id).toBe(dylan.id);
  });

  it('rejects a join that takes an existing name, a join for another agent, a second createTeam and unknown authors', async () => {
    const s = await Scenario.start();
    open.push(s.live);
    await s.createTeam('ronit');
    s.tick();
    const twin = await s.join('ronit'); // name ronit-claude already taken by the creator
    s.tick();
    const hlc = createHlc(() => s.now);
    hlc.observe(s.ops.at(-1)!.ts);
    const { op: secondTeam } = captureBootstrapOp(hlc, 'createTeam', {
      teamId: TEAM_ID, name: 'beta', repo: { provider: 'local', defaultBranch: 'main' }, member: 'eve', tool: 'claude',
      agentName: 'eve-claude', publicKey: newAgentKeyPair().publicKey,
    });
    const { op: otherTeamJoin } = captureBootstrapOp(hlc, 'join', {
      teamId: 'team-beta', member: 'zed', tool: 'claude', agentName: 'zed-claude', publicKey: newAgentKeyPair().publicKey,
    });
    const { op: forOther } = captureBootstrapOp(hlc, 'join', {
      teamId: TEAM_ID, member: 'mal', tool: 'claude', agentName: 'mal-claude', publicKey: newAgentKeyPair().publicKey,
    });
    const impersonation = { ...forOther, agent: twin.id }; // claims another agent's identity
    const ghost = captureOp(hlc, mintOpId(hlc.tick()), 'sendMessage', { to: 'all', body: 'boo' });
    await s.live.apply([secondTeam, otherTeamJoin, impersonation, ghost]);
    const errors = new Map((await s.live.store.ctx.db.selectFrom('applied_ops').selectAll().execute()).map((r) => [r.op_id, r]));
    expect(errors.get(twin.id)).toMatchObject({ status: 'rejected', error: 'conflict: agent name "ronit-claude" is already taken in this team' });
    expect(errors.get(secondTeam.id)).toMatchObject({ status: 'rejected', error: 'conflict: the team already exists; createTeam is valid only once' });
    expect(errors.get(otherTeamJoin.id)).toMatchObject({ status: 'rejected', error: 'forbidden: op belongs to a different team' });
    expect(errors.get(impersonation.id)).toMatchObject({ status: 'rejected', error: 'forbidden: an agent can only register its own key' });
    expect(errors.get(ghost.id)).toMatchObject({ status: 'rejected', error: 'unauthorized: unknown agent' });
    const agents = await s.live.store.ctx.db.selectFrom('agents').select('name').execute();
    expect(agents.map((a) => a.name)).toEqual(['ronit-claude']);
  });
});

describe('envelope validation', () => {
  it('rejects malformed timestamps, mismatched ids and unknown ops without applying them', async () => {
    const r = await replica(() => log.ops);
    await r.apply(log.ops.slice(0, 5));
    const base = log.ops[3]!; // a sendMessage by ronit
    const ts = formatHlc(Date.UTC(2026, 9, 16, 13), 0);
    const badTs: Op = { ...base, id: mintOpId(ts), ts: '2026-10-16 13:00:00' };
    const badId: Op = { ...base, id: mintOpId(formatHlc(Date.UTC(2026, 9, 16, 14), 0)), ts };
    const okTs = formatHlc(Date.UTC(2026, 9, 16, 15), 0);
    const unknownOp: Op = { ...base, id: mintOpId(okTs), ts: okTs, op: 'dropTables' };
    const badInputTs = formatHlc(Date.UTC(2026, 9, 16, 16), 0);
    const badInput: Op = { ...base, id: mintOpId(badInputTs), ts: badInputTs, input: { to: 'all' } };
    const before = await r.store.ctx.db.selectFrom('messages').select('id').execute();
    const summary = await r.apply([badTs, badId, unknownOp, badInput, { nonsense: true }]);
    expect(summary).toEqual({ applied: 0, rejected: 5, duplicates: 0, rebuilt: false });
    const rows = new Map((await r.store.ctx.db.selectFrom('applied_ops').selectAll().execute()).map((x) => [x.op_id, x]));
    expect(rows.get(badTs.id)).toMatchObject({ status: 'rejected', ts: null, error: 'invalid: malformed timestamp' });
    expect(rows.get(badId.id)).toMatchObject({ status: 'rejected', ts: null, error: 'invalid: op id does not match its timestamp' });
    expect(rows.get(unknownOp.id)).toMatchObject({ status: 'rejected', error: 'invalid: unknown op "dropTables"' });
    expect(rows.get(badInput.id)!.error).toMatch(/^invalid: /);
    expect(await r.store.ctx.db.selectFrom('messages').select('id').execute()).toEqual(before);
  });

  it('rebuilds when a different op reuses a known id, choosing the same winner on every replica', async () => {
    const original = log.ops[3]!;
    const forged: Op = { ...original, input: { to: 'all', body: 'forged', kind: 'fyi' } };
    const a = await replica(() => [...log.ops, forged]);
    const b = await replica(() => [...log.ops, forged]);
    await a.apply(log.ops);
    const summary = await a.apply([forged]);
    expect(summary.rebuilt).toBe(true);
    await b.apply([forged, ...log.ops]);
    expect(await a.dump()).toBe(await b.dump());
  });
});

describe('failure handling', () => {
  it('rolls the whole batch back and rethrows on an unexpected error', async () => {
    const r = await replica(() => log.ops);
    await r.apply(log.ops.slice(0, 10));
    const before = await r.dump();
    const failing = { allOps: async () => { throw new Error('object store unreadable'); } };
    // ops[0] already applied, so the batch is "late" and needs the (failing) source for a rebuild.
    await expect(r.apply([log.ops[10]!, log.ops[2]!, { ...log.ops[1]!, input: { changed: true } }], { source: failing }))
      .rejects.toThrow('object store unreadable');
    expect(await r.dump()).toBe(before);
    // Corrupt the schema under the replayer: a non-domain SQL error must not be recorded as a rejection.
    await r.store.ctx.db.schema.dropTable('commits').execute();
    await expect(r.apply(log.ops.slice(10))).rejects.toThrow(/commits/);
    const count = await r.store.ctx.db.selectFrom('applied_ops').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(10);
  });
});

describe('broadcast visibility', () => {
  it('matches the HTTP hub: a broadcast reaches agents that joined before it, never its sender', async () => {
    const r = await replica(() => log.ops);
    await r.apply(shuffle(log.ops, prng(7)));
    const inbox = async (a: ScenarioAgent) =>
      (await core.readInbox(r.store.ctx, await r.actor(a.id), { markRead: false })).map((m) => m.body);
    // kai joined after "welcome, early birds" and read everything else it could see.
    const kaiAll = await r.store.ctx.db.selectFrom('messages').select(['body', 'id']).where('to_agent_id', 'is', null).execute();
    const kaiActor = await r.actor(log.kai.id);
    const visibleToKai = kaiAll.filter((m) => m.id > kaiActor.id).map((m) => m.body).sort();
    expect(visibleToKai).toEqual(['standup in 5', 'thanks all']);
    expect(await inbox(log.kai)).toEqual(['thanks all']); // standup was marked read by kai's markRead op
    // ronit never sees its own broadcasts; ash's later broadcast reaches ronit.
    expect(await inbox(log.ronit)).toEqual(expect.arrayContaining(['thanks all']));
    expect(await inbox(log.ronit)).not.toContain('standup in 5');
    // dylan joined before the welcome, so it is in dylan's inbox (dylan never marked it read: it read earlier).
    expect(await inbox(log.dylan)).toEqual(expect.arrayContaining(['standup in 5', 'thanks all']));
  });
});
