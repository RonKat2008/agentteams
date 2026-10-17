import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as core from '@agentteams/hub/core';
import { newAgentKeyPair, newTeamKey } from '../../src/git/crypto.js';
import { createHlc, formatHlc } from '../../src/git/hlc.js';
import { captureBootstrapOp, captureOp, mintOpId } from '../../src/git/ops.js';
import { loadAgentKeys, rebuildView, takeNotices } from '../../src/git/replay.js';
import { decodeSegment, encodeSegment, type Op } from '../../src/git/segment.js';
import type { TeamCreator } from '../../src/git/replay.js';

const NO_DIR = { idOf: () => undefined };
import {
  Scenario, TEAM_ID, TEST_NOW, batches, buildLog, openReplica, prng, shuffle, type Built, type Replica, type ScenarioAgent,
} from './replayHelpers.js';

const open: Replica[] = [];
async function replica(source: () => unknown[], localAgentId?: string, creator?: TeamCreator): Promise<Replica> {
  const r = await openReplica(source, localAgentId, () => creator ?? log?.creator);
  open.push(r);
  return r;
}
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const rowsOf = async (r: Replica) =>
  new Map((await r.store.ctx.db.selectFrom('applied_ops').selectAll().execute()).map((x) => [`${x.agent}/${x.op_id}`, x]));
const rowOf = async (r: Replica, op: Pick<Op, 'agent' | 'id'>) => (await rowsOf(r)).get(`${op.agent}/${op.id}`);

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
    expect(log.sameTsPair[0].ts).toBe(log.sameTsPair[1].ts);
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
    const summary = await rebuildView(rebuilt.store, { source: { allOps: async () => all }, teamId: TEAM_ID, nowMs: TEST_NOW, teamCreator: log.creator });
    expect(summary).toMatchObject({ rebuilt: true, applied: all.length - 2, rejected: 2 });
    expect(await rebuilt.dump()).toBe(reference);
  });

  it('converges when two agents share one ts, whichever arrives first', async () => {
    const [a, b] = log.sameTsPair;
    const rest = log.ops.filter((o) => o !== a && o !== b);
    const ab = await replica(() => log.ops);
    const ba = await replica(() => log.ops);
    await ab.apply([...rest, a]);
    await ab.apply([b]);
    await ba.apply([...rest, b]);
    await ba.apply([a]);
    expect(await ab.dump()).toBe(reference);
    expect(await ba.dump()).toBe(reference);
    expect((await rowOf(ab, a))?.status).toBe('applied');
    expect((await rowOf(ab, b))?.status).toBe('applied');
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

    expect(await r.apply([])).toEqual({ applied: 0, rejected: 0, duplicates: 0, deferred: 0, backdated: 0, rebuilt: false });
  });

  it('treats re-applying the same ops as a no-op', async () => {
    const r = await replica(() => log.ops);
    await r.apply(log.ops);
    const before = await r.dump();
    const again = await r.apply(shuffle(log.ops, prng(9)));
    expect(again).toEqual({ applied: 0, rejected: 0, duplicates: log.ops.length, deferred: 0, backdated: 0, rebuilt: false });
    expect(await r.dump()).toBe(before);
  });
});

describe('conflicts and notices', () => {
  it('resolves concurrent claimTask the same way everywhere and notifies the loser', async () => {
    const forKai = await replica(() => log.ops, log.kai.id);
    const forDylan = await replica(() => log.ops, log.dylan.id);
    await forKai.apply(log.ops);
    await forDylan.apply(shuffle(log.ops, prng(42)));
    for (const r of [forKai, forDylan]) {
      const task = await r.store.ctx.db.selectFrom('tasks').selectAll().where('number', '=', 3).executeTakeFirstOrThrow();
      expect(task.assignee_agent_id).toBe(log.dylan.id);
      expect(await rowOf(r, log.claimByKai)).toMatchObject({ status: 'rejected', error: 'forbidden' });
    }
    expect(await forKai.dump()).toBe(await forDylan.dump());

    const notices = await takeNotices(forKai.store, log.kai.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.opId).toBe(log.claimByKai.id);
    expect(notices[0]!.body).toMatch(/Your claimTask .* was rejected .*only the assignee \(dylan-claude\) can claim task #3/);
    expect(await takeNotices(forKai.store, log.kai.id)).toEqual([]); // delivered once
    expect(await takeNotices(forDylan.store, log.dylan.id)).toEqual([]);
  });

  it('tells the author when its claimFiles is refused, while the op stays applied', async () => {
    const r = await replica(() => log.ops, log.ash.id);
    await r.apply(log.ops);
    expect(await rowOf(r, log.ashClaimFiles)).toMatchObject({ status: 'applied', error: null });
    const notices = await takeNotices(r.store, log.ash.id);
    expect(notices.map((n) => n.opId)).toEqual([log.ashClaimFiles.id]);
    expect(notices[0]!.body).toContain('your file claim was refused by the team log: already claimed src/a/** (dylan-claude)');
  });

  it('keeps a notice across rebuilds without duplicating it, and withdraws it if the op later succeeds', async () => {
    const r = await replica(() => log.ops, log.kai.id);
    const peek = async () =>
      (await r.store.ctx.db.selectFrom('replica_notices').select('op_id').where('agent_id', '=', log.kai.id).execute()).map((n) => n.op_id);
    await r.apply(log.ops.filter((o) => o !== log.claimByDylan)); // kai's claim succeeds
    expect(await peek()).toEqual([]);
    await r.apply([log.claimByDylan]); // rebuild: kai's claim now loses
    expect(await peek()).toEqual([log.claimByKai.id]);
    await rebuildView(r.store, { source: { allOps: async () => log.ops }, teamId: TEAM_ID, localAgentId: log.kai.id, nowMs: TEST_NOW, teamCreator: log.creator });
    expect(await peek()).toEqual([log.claimByKai.id]);
  });

  it('rejects an orchestrator-only op by a non-orchestrator', async () => {
    const r = await replica(() => log.ops);
    await r.apply(log.ops);
    expect(await rowOf(r, log.rejectedCreate)).toMatchObject({ status: 'rejected', error: 'forbidden' });
    const titles = (await r.store.ctx.db.selectFrom('tasks').select('title').execute()).map((t) => t.title);
    expect(titles).not.toContain('not allowed any more');
  });
});

describe('registration', () => {
  it('suffixes a join that takes a name; rejects other-team joins, impersonation, a non-creator createTeam, unknown authors', async () => {
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
    const impersonation = { ...forOther, agent: twin.id }; // registers someone else's id
    const wrongInputId = { ...forOther, input: { ...(forOther.input as object), agentId: twin.id } };
    const ghost = captureOp(hlc, mintOpId(hlc.tick()), 'sendMessage', { to: 'all', body: 'boo' }, NO_DIR);
    await s.live.apply([secondTeam, otherTeamJoin, impersonation, wrongInputId, ghost]);
    expect(await rowOf(s.live, s.ops[1]!)).toMatchObject({ status: 'applied', error: null });
    expect(await rowOf(s.live, secondTeam)).toMatchObject({ status: 'rejected', error: 'not-creator' });
    expect(await rowOf(s.live, otherTeamJoin)).toMatchObject({ status: 'rejected', error: 'wrong-team' });
    expect(await rowOf(s.live, impersonation)).toMatchObject({ status: 'rejected', error: 'bootstrap-id' });
    expect(await rowOf(s.live, wrongInputId)).toMatchObject({ status: 'rejected', error: 'bootstrap-id' });
    expect(await rowOf(s.live, ghost)).toMatchObject({ status: 'rejected', error: 'unknown-agent' });
    const agents = await s.live.store.ctx.db.selectFrom('agents').select('name').execute();
    expect(agents.map((a) => a.name).sort()).toEqual(['ronit-claude', 'ronit-claude-2']);
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
    expect(summary).toEqual({ applied: 0, rejected: 5, duplicates: 0, deferred: 0, backdated: 0, rebuilt: false });
    expect(await rowOf(r, badTs)).toMatchObject({ status: 'rejected', ts: null, error: 'malformed' });
    expect(await rowOf(r, badId)).toMatchObject({ status: 'rejected', ts: null, error: 'malformed' });
    expect(await rowOf(r, unknownOp)).toMatchObject({ status: 'rejected', error: 'unknown-op' });
    expect(await rowOf(r, badInput)).toMatchObject({ status: 'rejected', error: 'invalid' });
    expect(await r.store.ctx.db.selectFrom('messages').select('id').execute()).toEqual(before);
  });
});

describe('segment round trip', () => {
  it('captured ops survive encode/decode with keys loaded from the view, then replay', async () => {
    const teamKey = newTeamKey();
    const pair = newAgentKeyPair();
    const hlc = createHlc(() => Date.UTC(2026, 9, 16, 9));
    const { agentId, op: create } = captureBootstrapOp(hlc, 'createTeam', {
      teamId: TEAM_ID, name: 'alpha', repo: { provider: 'local', defaultBranch: 'main' }, member: 'ronit', tool: 'claude',
      agentName: 'ronit-claude', publicKey: pair.publicKey,
    });
    const hello = captureOp(hlc, agentId, 'sendMessage', { to: 'all', body: 'hello' }, NO_DIR);
    const seg0 = encodeSegment({ teamId: TEAM_ID, agent: agentId, seq: 0, ops: [create] }, teamKey, pair.privateKey);
    const seg1 = encodeSegment({ teamId: TEAM_ID, agent: agentId, seq: 1, ops: [hello] }, teamKey, pair.privateKey);

    const r = await replica(() => [create, hello], undefined, { agentId, publicKey: pair.publicKey });
    let keys = await loadAgentKeys(r.store);
    const d0 = decodeSegment(seg0, teamKey, { teamId: TEAM_ID, agent: agentId, seq: 0 }, (id) => keys.get(id));
    expect(d0).toMatchObject({ ok: true, bootstrapKey: pair.publicKey });
    if (!d0.ok) throw new Error('decode failed');
    expect(await r.apply(d0.segment.ops)).toMatchObject({ applied: 1, rejected: 0 });

    keys = await loadAgentKeys(r.store);
    expect(keys.get(agentId)).toBe(pair.publicKey);
    const d1 = decodeSegment(seg1, teamKey, { teamId: TEAM_ID, agent: agentId, seq: 1 }, (id) => keys.get(id));
    if (!d1.ok) throw new Error('decode failed');
    expect(await r.apply(d1.segment.ops)).toMatchObject({ applied: 1, rejected: 0 });
    expect((await r.store.ctx.db.selectFrom('messages').select('body').execute()).map((m) => m.body)).toEqual(['hello']);
  });
});

describe('failure handling', () => {
  it('rolls the whole batch back and rethrows on an unexpected error', async () => {
    const r = await replica(() => log.ops);
    const late = log.ops[5]!;
    await r.apply(log.ops.slice(0, 10).filter((o) => o !== late));
    const before = await r.dump();
    const failing = { allOps: async () => { throw new Error('object store unreadable'); } };
    // The late op forces a rebuild, which needs the (failing) source.
    await expect(r.apply([log.ops[10]!, late], { source: failing })).rejects.toThrow('object store unreadable');
    expect(await r.dump()).toBe(before);
    // Corrupt the schema under the replayer: a non-domain SQL error must not be recorded as a rejection.
    await r.store.ctx.db.schema.dropTable('commits').execute();
    await expect(r.apply(log.ops.slice(10))).rejects.toThrow(/commits/);
    const count = await r.store.ctx.db.selectFrom('applied_ops').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(9);
  });
});

describe('broadcast visibility', () => {
  it('matches the HTTP hub: a broadcast reaches agents that joined before it, never its sender', async () => {
    const r = await replica(() => log.ops);
    await r.apply(shuffle(log.ops, prng(7)));
    const inbox = async (a: ScenarioAgent) =>
      (await core.readInbox(r.store.ctx, await r.actor(a.id), { markRead: false })).map((m) => m.body);
    const broadcasts = await r.store.ctx.db.selectFrom('messages').select(['body', 'id']).where('to_agent_id', 'is', null).execute();
    const kaiActor = await r.actor(log.kai.id);
    const visibleToKai = broadcasts.filter((m) => m.id > kaiActor.id).map((m) => m.body).sort();
    // kai joined after "welcome, early birds"; its own broadcast is visible by id but excluded as sender.
    expect(visibleToKai).toEqual(['same tick from dylan', 'same tick from kai', 'standup in 5', 'thanks all']);
    expect((await inbox(log.kai)).sort()).toEqual(['same tick from dylan', 'thanks all']); // standup was marked read
    expect(await inbox(log.ronit)).toEqual(expect.arrayContaining(['thanks all']));
    expect(await inbox(log.ronit)).not.toContain('standup in 5');
    expect(await inbox(log.dylan)).toEqual(expect.arrayContaining(['standup in 5', 'thanks all', 'same tick from kai']));
    expect(await inbox(log.dylan)).not.toContain('same tick from dylan');
  });
});
