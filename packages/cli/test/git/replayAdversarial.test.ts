import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newAgentKeyPair, newTeamKey } from '../../src/git/crypto.js';
import { createHlc, formatHlc, parseHlc } from '../../src/git/hlc.js';
import { captureBootstrapOp, captureOp, mintOpId } from '../../src/git/ops.js';
import { deferFutureOps, getPinnedKey, loadAgentKeys, pinAgentKey, rebuildView } from '../../src/git/replay.js';
import { decodeSegment, encodeSegment, type Op } from '../../src/git/segment.js';
import { Scenario, TEAM_ID, TEST_NOW, buildLog, openReplica, type Built, type Replica } from './replayHelpers.js';

const open: Replica[] = [];
async function replica(source: () => unknown[], localAgentId?: string): Promise<Replica> {
  const r = await openReplica(source, localAgentId);
  open.push(r);
  return r;
}
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

const rowsFor = async (r: Replica, op: Pick<Op, 'agent' | 'id'>) =>
  r.store.ctx.db.selectFrom('applied_ops').selectAll().where('agent', '=', op.agent).where('op_id', '=', op.id).execute();
const countRebuilds = async (r: Replica) =>
  Number((await r.store.ctx.db.selectFrom('replica_state').select('value').where('key', '=', 'rebuilds').executeTakeFirst())?.value ?? 0);

let log: Built;
let reference: string;
beforeAll(async () => {
  log = await buildLog();
  reference = await log.s.live.dump();
});

/** A registered attacker agent ("mal") joining right after the team was created. */
function attackerJoin(): { mal: string; join: Op } {
  const createMs = parseHlc(log.ops[0]!.ts)!.ms;
  const hlc = createHlc(() => createMs + 500);
  const { agentId, op } = captureBootstrapOp(hlc, 'join', {
    teamId: TEAM_ID, member: 'mal', tool: 'claude', agentName: 'mal-claude', publicKey: newAgentKeyPair().publicKey,
  });
  return { mal: agentId, join: op };
}

describe('op identity is (agent, id)', () => {
  it('an op reusing the victim createTeam id and ts does not remove it (probe P1)', async () => {
    const victim = log.ops[0]!; // createTeam
    const { mal, join } = attackerJoin();
    const shadow: Op = { ...victim, agent: mal, op: 'sendMessage', input: { to: 'all', body: 'gotcha' } };
    const zeroShadow: Op = {
      ...victim, agent: '0'.repeat(26), op: 'join',
      input: { teamId: TEAM_ID, member: 'z', tool: 'claude', agentId: '0'.repeat(26), agentName: 'z-claude', publicKey: 'A'.repeat(43) },
    };
    const all = [...log.ops, join, shadow, zeroShadow];
    const r = await replica(() => all);
    await r.apply([shadow, zeroShadow, join]);
    await r.apply(log.ops);
    expect(await r.store.ctx.db.selectFrom('teams').select('id').execute()).toHaveLength(1);
    expect((await rowsFor(r, victim))[0]).toMatchObject({ status: 'applied' });
    expect((await rowsFor(r, shadow))[0]).toMatchObject({ status: 'rejected', error: 'unknown-agent' }); // sorts before mal joined
    expect((await rowsFor(r, zeroShadow))[0]).toMatchObject({ status: 'rejected', error: 'bootstrap-id' });
  });

  it('an op sharing the victim ts and id cannot collide with its rows (probe P2)', async () => {
    // Victim: kai's broadcast (kai joined last). Its rows: message (n=0), activity (n=1).
    // Attacker: mal joined early, so mal's ops sort before kai's at an equal ts. A one-glob claimFiles
    // under the same ts and id makes rows claim (n=0), activity (n=1): with ids derived from the op id
    // alone, mal's activity row would take kai's activity id and kai's op would be rejected.
    const victim = log.sameTsPair[1];
    const { mal, join } = attackerJoin();
    const attack: Op = { v: 1, id: victim.id, ts: victim.ts, agent: mal, op: 'claimFiles', input: { globs: ['x/**'] } };
    const all = [...log.ops, join, attack];
    const r = await replica(() => all);
    await r.apply(all);
    expect((await rowsFor(r, attack))[0]).toMatchObject({ status: 'applied' });
    expect((await rowsFor(r, victim))[0]).toMatchObject({ status: 'applied', error: null });
    const bodies = (await r.store.ctx.db.selectFrom('messages').select('body').execute()).map((m) => m.body);
    expect(bodies).toContain('same tick from kai');
  });

  it('rejects the all-zero agent id (its join id cannot match a valid ts)', async () => {
    const zero = '0'.repeat(26);
    const ts = formatHlc(Date.UTC(2026, 9, 16, 12, 0, 1), 0);
    const zeroJoin: Op = {
      v: 1, id: zero, ts, agent: zero, op: 'join',
      input: { teamId: TEAM_ID, member: 'z', tool: 'claude', agentId: zero, agentName: 'z-claude', publicKey: 'A'.repeat(43) },
    };
    const r = await replica(() => [...log.ops, zeroJoin]);
    await r.apply([...log.ops, zeroJoin]);
    expect((await rowsFor(r, zeroJoin))[0]).toMatchObject({ status: 'rejected', error: 'malformed', ts: null });
    expect(await r.store.ctx.db.selectFrom('agents').select('id').where('id', '=', zero).execute()).toEqual([]);
  });

  it('settles equivocation by content hash everywhere and never rebuilds for the loser again', async () => {
    const original = log.ops[3]!; // ronit's welcome broadcast
    const forged: Op = { ...original, input: { to: 'all', body: 'forged', kind: 'fyi' } };
    const a = await replica(() => [...log.ops, forged]);
    const b = await replica(() => [...log.ops, forged]);
    await a.apply(log.ops);
    await a.apply([forged]);
    await b.apply([forged, ...log.ops]);
    expect(await a.dump()).toBe(await b.dump());
    const rows = await rowsFor(a, original);
    expect(rows).toHaveLength(2);
    expect(rows.filter((x) => x.error === 'equivocation')).toHaveLength(1);
    const before = await countRebuilds(a);
    const again = await a.apply([forged, original]);
    expect(again).toMatchObject({ duplicates: 2, rebuilt: false });
    expect(await countRebuilds(a)).toBe(before);
  });
});

describe('key pins', () => {
  it('survive a rebuild that rejects the pinned join after an honest name race (probe P3)', async () => {
    const s = await Scenario.start();
    open.push(s.live);
    await s.createTeam('ronit');
    s.tick(1000);
    const dylan = await s.join('dylan');
    expect(await pinAgentKey(s.live.store, dylan.id, dylan.publicKey)).toBe('pinned');
    // The same person joined from another machine 500 ms earlier, under the same name.
    const other = newAgentKeyPair();
    const hlc = createHlc(() => s.now - 500);
    const { op: earlierJoin } = captureBootstrapOp(hlc, 'join', {
      teamId: TEAM_ID, member: 'dylan', tool: 'claude', agentName: 'dylan-claude', publicKey: other.publicKey,
    });
    const summary = await s.live.apply([earlierJoin]);
    expect(summary.rebuilt).toBe(true);
    expect((await rowsFor(s.live, { agent: dylan.id, id: dylan.id }))[0]).toMatchObject({ status: 'rejected', error: 'conflict' });

    expect(await getPinnedKey(s.live.store, dylan.id)).toBe(dylan.publicKey);
    expect(await pinAgentKey(s.live.store, dylan.id, dylan.publicKey)).toBe('match');
    expect(await pinAgentKey(s.live.store, dylan.id, other.publicKey)).toBe('mismatch');
    const keys = await loadAgentKeys(s.live.store);
    expect(keys.get(dylan.id)).toBe(dylan.publicKey);

    // A fresh seq-0 bootstrap at dylan's ref under a different key is refused.
    const teamKey = newTeamKey();
    const forged = encodeSegment({
      teamId: TEAM_ID, agent: dylan.id, seq: 0,
      ops: [{ ...s.ops.find((o) => o.id === dylan.id)!, input: { ...(s.ops.find((o) => o.id === dylan.id)!.input as object), publicKey: other.publicKey } }],
    }, teamKey, other.privateKey);
    const decoded = decodeSegment(forged, teamKey, { teamId: TEAM_ID, agent: dylan.id, seq: 0 }, (id) => keys.get(id));
    expect(decoded).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a bootstrap op whose key mismatches an existing pin', async () => {
    const r = await replica(() => log.ops);
    await pinAgentKey(r.store, log.kai.id, newAgentKeyPair().publicKey);
    await r.apply(log.ops);
    expect((await rowsFor(r, { agent: log.kai.id, id: log.kai.id }))[0]).toMatchObject({ status: 'rejected', error: 'pin-mismatch' });
    await expect(pinAgentKey(r.store, 'bad id', 'A'.repeat(43))).rejects.toThrow('invalid agent id');
    await expect(pinAgentKey(r.store, log.kai.id, 'short')).rejects.toThrow('invalid public key');
  });
});

describe('future timestamps', () => {
  it('defers a far-future op instead of rejecting it, without forcing rebuilds, and applies it once due', async () => {
    const ronit = log.ronit;
    const futureMs = TEST_NOW + 24 * 60 * 60 * 1000;
    const future = captureOp(createHlc(() => futureMs), ronit.id, 'sendMessage', { to: 'all', body: 'from the future' });
    expect(deferFutureOps([future, log.ops[0]!], TEST_NOW)).toEqual({ ready: [log.ops[0]], deferred: [future] });

    const head = log.ops.slice(0, -3);
    const tail = log.ops.slice(-3);
    let stored: Op[] = [...head, future];
    const r = await replica(() => stored);
    expect(await r.apply([...head, future])).toMatchObject({ deferred: 1, rebuilt: false });
    expect(await rowsFor(r, future)).toEqual([]);
    stored = [...stored, ...tail];
    for (const op of tail) expect(await r.apply([op])).toMatchObject({ rebuilt: false, deferred: 0 });
    expect(await countRebuilds(r)).toBe(0);
    expect(await r.dump()).toBe(reference); // the deferred op is invisible

    await rebuildView(r.store, { source: { allOps: async () => stored }, teamId: TEAM_ID, nowMs: TEST_NOW });
    expect(await r.dump()).toBe(reference);

    const later = await r.apply([future], { nowMs: futureMs });
    expect(later).toMatchObject({ applied: 1, deferred: 0, rebuilt: false });
  });
});
