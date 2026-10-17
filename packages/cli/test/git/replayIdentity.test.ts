import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newAgentKeyPair } from '../../src/git/crypto.js';
import { createHlc, parseHlc } from '../../src/git/hlc.js';
import { captureBootstrapOp, captureOp } from '../../src/git/ops.js';
import {
  getPinnedTeamMeta, loadAgentDirectory, pinAgentKey, pinTeamMeta, rebuildView,
} from '../../src/git/replay.js';
import type { Op } from '../../src/git/segment.js';
import { TEAM_ID, TEST_NOW, buildLog, openReplica, takeNotices, type Built, type Replica } from './replayHelpers.js';

const open: Replica[] = [];
async function replica(source: () => unknown[], localAgentId?: string): Promise<Replica> {
  const r = await openReplica(source, localAgentId, () => log.creator);
  open.push(r);
  return r;
}
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

let log: Built;
beforeAll(async () => {
  log = await buildLog();
});

const msOf = (op: Op): number => parseHlc(op.ts)!.ms;
const rowFor = async (r: Replica, op: Pick<Op, 'agent' | 'id'>) =>
  r.store.ctx.db.selectFrom('applied_ops').selectAll().where('agent', '=', op.agent).where('op_id', '=', op.id).executeTakeFirst();
const statuses = async (r: Replica, agent: string) =>
  (await r.store.ctx.db.selectFrom('applied_ops').select(['op_id', 'status', 'error']).where('agent', '=', agent).execute());

/** A bootstrap op minted on a clock set to `ms` (an attacker backdating its own clock). */
function backdatedJoin(ms: number, member: string, agentName = `${member}-claude`): Op {
  return captureBootstrapOp(createHlc(() => ms), 'join', {
    teamId: TEAM_ID, member, tool: 'claude', agentName, publicKey: newAgentKeyPair().publicKey,
  }).op;
}

describe('team creator authenticity', () => {
  it('rejects a backdated createTeam by anyone but the pinned creator', async () => {
    const create = log.ops[0]!;
    const fake = captureBootstrapOp(createHlc(() => msOf(create) - 1000), 'createTeam', {
      teamId: TEAM_ID, name: 'hijacked', repo: { provider: 'local', defaultBranch: 'main' }, member: 'mal', tool: 'claude',
      agentName: 'mal-claude', publicKey: newAgentKeyPair().publicKey,
    }).op;
    const all = [...log.ops, fake];
    const r = await replica(() => all);
    await r.apply(log.ops);
    const summary = await r.apply([fake]);
    expect(summary).toMatchObject({ rebuilt: true, backdated: 1 });
    expect(await rowFor(r, fake)).toMatchObject({ status: 'rejected', error: 'not-creator' });
    const team = await r.store.ctx.db.selectFrom('teams').selectAll().executeTakeFirstOrThrow();
    expect(team).toMatchObject({ name: 'alpha', creator_agent_id: log.ronit.id });
    expect((await statuses(r, log.ronit.id)).filter((x) => x.status === 'rejected').map((x) => x.op_id)).toEqual([log.rejectedCreate.id]);
  });

  it('pins the team meta on first sight and never replaces it', async () => {
    const r = await replica(() => []);
    const meta = { agentId: log.ronit.id, publicKey: log.ronit.publicKey, name: 'alpha' };
    expect(await pinTeamMeta(r.store, TEAM_ID, meta)).toBe('pinned');
    expect(await pinTeamMeta(r.store, TEAM_ID, { ...meta, name: 'renamed' })).toBe('match');
    expect(await pinTeamMeta(r.store, TEAM_ID, { ...meta, publicKey: newAgentKeyPair().publicKey })).toBe('mismatch');
    expect(await getPinnedTeamMeta(r.store, TEAM_ID)).toEqual(meta);
    expect(await getPinnedTeamMeta(r.store, 'other-team')).toBeUndefined();
    await r.apply(log.ops);
    await r.store.ctx.db.deleteFrom('applied_ops').execute(); // any rebuild-style wipe leaves pins alone
    expect(await getPinnedTeamMeta(r.store, TEAM_ID)).toEqual(meta);
  });
});

describe('names vs ids', () => {
  it('carries agent ids, not names, in ops that target agents', () => {
    const byOp = (name: string) => log.ops.filter((o) => o.op === name).map((o) => o.input as Record<string, unknown>);
    expect(byOp('createTask')[0]).toMatchObject({ assignee: log.dylan.id });
    expect(byOp('assignTask')[0]).toMatchObject({ assignee: log.ash.id });
    expect(byOp('setOrchestrator')[0]).toEqual({ agent: log.ash.id });
    expect(byOp('sendMessage').map((i) => i.to)).toContain(log.dylan.id);
    expect(byOp('sendMessage').map((i) => i.to)).toContain('all');
  });

  it('gives a backdated same-name join a suffix; the victim keeps its messages and assignments', async () => {
    const squat = backdatedJoin(msOf(log.ops[1]!) - 500, 'dylan'); // between createTeam and dylan's real join
    const all = [...log.ops, squat];
    const r = await replica(() => all, log.dylan.id);
    await r.apply(log.ops);
    expect(await r.apply([squat])).toMatchObject({ rebuilt: true, backdated: 1 });

    expect((await r.actor(squat.agent)).name).toBe('dylan-claude');
    expect((await r.actor(log.dylan.id)).name).toBe('dylan-claude-2');
    expect((await statuses(r, log.dylan.id)).every((x) => x.status === 'applied')).toBe(true);
    const task1 = await r.store.ctx.db.selectFrom('tasks').selectAll().where('number', '=', 1).executeTakeFirstOrThrow();
    expect(task1.assignee_agent_id).toBe(log.dylan.id);
    const toSquatter = await r.store.ctx.db.selectFrom('messages').select('body').where('to_agent_id', '=', squat.agent).execute();
    expect(toSquatter).toEqual([]);
    const toDylan = (await r.store.ctx.db.selectFrom('messages').select('body').where('to_agent_id', '=', log.dylan.id).execute())
      .map((m) => m.body);
    expect(toDylan).toEqual(expect.arrayContaining(['need help with src/a?', expect.stringContaining('Task #1 assigned to you')]));
    const notices = await takeNotices(r.store, log.dylan.id);
    expect(notices.map((n) => n.body)).toContainEqual(expect.stringContaining('you joined as "dylan-claude-2"'));
  });

  it('resolves names at capture time against the view and refuses unknown names', async () => {
    const r = await replica(() => log.ops);
    await r.apply(log.ops);
    const dir = await loadAgentDirectory(r.store, TEAM_ID);
    expect(dir.idOf('kai-cursor')).toBe(log.kai.id);
    const hlc = createHlc(() => Date.UTC(2026, 9, 16, 13));
    expect(captureOp(hlc, log.ash.id, 'sendMessage', { to: 'kai-cursor', body: 'hi' }, dir).input).toMatchObject({ to: log.kai.id });
    expect(() => captureOp(hlc, log.ash.id, 'sendMessage', { to: 'nobody-claude', body: 'hi' }, dir)).toThrow(/no agent named/);
  });
});

describe('commit credit', () => {
  it('keeps the real author record when another agent backdates a record of the same sha and branch', async () => {
    const real = log.ops.find((o) => o.op === 'recordCommit' && o.agent === log.dylan.id)!;
    const mal = backdatedJoin(msOf(log.ops[1]!) + 1, 'mal');
    const fake = captureOp(createHlc(() => msOf(real) - 1), mal.agent, 'recordCommit', {
      ...(real.input as Record<string, unknown>), message: 'mine now', files: ['decoy.txt'],
    } as never, { idOf: () => undefined });
    const all = [...log.ops, mal, fake];
    const r = await replica(() => all);
    await r.apply(all);
    expect(await rowFor(r, fake)).toMatchObject({ status: 'applied' });
    expect(await rowFor(r, real)).toMatchObject({ status: 'applied' });
    const sha = (real.input as { sha: string }).sha;
    const rows = await r.store.ctx.db.selectFrom('commits').select(['agent_id', 'message']).where('sha', '=', sha).execute();
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ agent_id: log.dylan.id, message: 'parser: tokens' });
    expect(rows).toContainEqual({ agent_id: mal.agent, message: 'mine now' });
  });
});

describe('equivocating joins prefer the pinned key', () => {
  it('picks the variant matching this replica pin, over the content hash', async () => {
    const hlc = createHlc(() => msOf(log.ops[1]!) + 7);
    const a = newAgentKeyPair().publicKey;
    const { op: first } = captureBootstrapOp(hlc, 'join', { teamId: TEAM_ID, member: 'eve', tool: 'claude', agentName: 'eve-claude', publicKey: a });
    const second: Op = { ...first, input: { ...(first.input as object), publicKey: newAgentKeyPair().publicKey } };
    const all = [...log.ops, first, second];
    for (const pinned of [first, second]) {
      const r = await replica(() => all);
      const key = (pinned.input as { publicKey: string }).publicKey;
      expect(await pinAgentKey(r.store, first.agent, key)).toBe('pinned');
      await r.apply(all);
      const reg = await r.store.ctx.db.selectFrom('agent_keys').select('public_key').where('agent_id', '=', first.agent).executeTakeFirstOrThrow();
      expect(reg.public_key).toBe(key);
    }
  });
});

describe('competing createTeam variants', () => {
  it('prefer the variant whose key matches the pinned creator, whatever the hashes', async () => {
    const real = log.ops[0]!;
    const forgedKeys = Array.from({ length: 12 }, () => newAgentKeyPair().publicKey); // some hash above, some below
    for (const key of forgedKeys) {
      const forged: Op = { ...real, input: { ...(real.input as object), publicKey: key } };
      const r = await replica(() => [...log.ops, forged]);
      await r.apply([forged, ...log.ops]);
      expect(await r.store.ctx.db.selectFrom('teams').select('creator_agent_id').execute()).toEqual([{ creator_agent_id: log.ronit.id }]);
      const rows = await r.store.ctx.db.selectFrom('applied_ops').select(['hash', 'status', 'error'])
        .where('agent', '=', real.agent).where('op_id', '=', real.id).execute();
      expect(rows.map((x) => x.error).sort()).toEqual(['equivocation', null].sort());
    }
  });
});

describe('task targets', () => {
  it('a late or backdated createTask cannot redirect task ops captured earlier (decoy probe)', async () => {
    const handover = log.ops.find((o) => o.op === 'setOrchestrator')!;
    // Ronit, still orchestrator 1 ms before the handover, publishes a decoy late (offline or backdated).
    const decoy = captureOp(createHlc(() => msOf(handover) - 1), log.ronit.id, 'createTask', { title: 'DECOY' }, { idOf: () => undefined });
    const all = [...log.ops, decoy];
    const r = await replica(() => all);
    await r.apply(log.ops);
    expect(await r.apply([decoy])).toMatchObject({ rebuilt: true });
    expect(await rowFor(r, decoy)).toMatchObject({ status: 'applied' });

    const tasks = await r.store.ctx.db.selectFrom('tasks').selectAll().orderBy('number').execute();
    const byTitle = new Map(tasks.map((t) => [t.title, t]));
    expect(byTitle.get('DECOY')).toMatchObject({ number: 3, status: 'open', assignee_agent_id: null });
    // Dylan claimed "Fix the flaky test" by its row id: the claim still lands there, now as task #4.
    expect(byTitle.get('Fix the flaky test')).toMatchObject({ number: 4, status: 'in_progress', assignee_agent_id: log.dylan.id });
    expect(await rowFor(r, log.claimByKai)).toMatchObject({ status: 'rejected', error: 'forbidden' });
    expect((log.claimByDylan.input as { task: unknown }).task).toBe(byTitle.get('Fix the flaky test')!.id);
  });
});

describe('rename notices', () => {
  it('tells the local agent when a rebuild renames a teammate and reuses the name', async () => {
    const squat = backdatedJoin(msOf(log.ops[1]!) - 500, 'dylan');
    const all = [...log.ops, squat];
    const r = await replica(() => all, log.ash.id);
    await r.apply(log.ops);
    await takeNotices(r.store, log.ash.id); // drop the claim-refusal notice
    await r.apply([squat]);
    const bodies = (await takeNotices(r.store, log.ash.id)).map((n) => n.body);
    expect(bodies).toEqual([
      `Team change: agent "dylan-claude" (${log.dylan.id}) is now called "dylan-claude-2"; `
        + `the name "dylan-claude" now refers to another agent (${squat.agent}).`,
    ]);
    // Re-applying (another rebuild with the same outcome) adds nothing.
    await rebuildView(r.store, {
      source: { allOps: async () => all }, teamId: TEAM_ID, teamCreator: log.creator, localAgentId: log.ash.id, nowMs: TEST_NOW,
    });
    expect(await takeNotices(r.store, log.ash.id)).toEqual([]);
  });
});

describe('long names', () => {
  it('truncates a suffixed name so it stays a valid, addressable agent name', async () => {
    const T = Date.UTC(2026, 9, 16, 8);
    const ronitKey = newAgentKeyPair().publicKey;
    const { agentId: ronit, op: create } = captureBootstrapOp(createHlc(() => T), 'createTeam', {
      teamId: TEAM_ID, name: 'alpha', repo: { provider: 'local', defaultBranch: 'main' }, member: 'ronit', tool: 'claude',
      agentName: 'ronit-claude', publicKey: ronitKey,
    });
    const longName = `dylan-${'c'.repeat(30)}`;
    const victim = backdatedJoin(T + 2000, 'dylan', longName);
    const ops: Op[] = [create, victim];
    const r = await openReplica(() => ops, undefined, () => ({ agentId: ronit, publicKey: ronitKey }));
    open.push(r);
    await r.apply(ops);
    const dm = captureOp(createHlc(() => T + 3000), ronit, 'sendMessage', { to: longName, body: 'for the long one' },
      await loadAgentDirectory(r.store, TEAM_ID));
    ops.push(dm);
    await r.apply([dm]);

    const squat = backdatedJoin(T + 1000, 'dylan', longName);
    ops.push(squat);
    expect(await r.apply([squat])).toMatchObject({ rebuilt: true });
    const renamed = (await r.actor(victim.agent)).name;
    expect(renamed).toBe(`dylan-${'c'.repeat(28)}-2`);
    expect(renamed).toMatch(/^[a-z0-9_]{1,24}-[a-z0-9-]{1,30}$/);
    expect(await rowFor(r, dm)).toMatchObject({ status: 'applied' });
    const toVictim = await r.store.ctx.db.selectFrom('messages').select('body').where('to_agent_id', '=', victim.agent).execute();
    expect(toVictim.map((m) => m.body)).toEqual(['for the long one']);

    const again = captureOp(createHlc(() => T + 4000), ronit, 'sendMessage', { to: renamed, body: 'by new name' },
      await loadAgentDirectory(r.store, TEAM_ID));
    ops.push(again);
    expect(await r.apply([again])).toMatchObject({ applied: 1, rejected: 0 });
  });
});
