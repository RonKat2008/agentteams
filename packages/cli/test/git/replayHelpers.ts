import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@agentteams/hub/core';
import type { Actor } from '@agentteams/hub/core';
import { newAgentKeyPair } from '../../src/git/crypto.js';
import { createHlc, type Hlc } from '../../src/git/hlc.js';
import {
  captureBootstrapOp, captureOp, type OpInput, type RegularOpName,
} from '../../src/git/ops.js';
import {
  REPLICATED_TABLES, applyOps, loadAgentDirectory, type ApplyOptions, type ReplayStore, type TeamCreator,
} from '../../src/git/replay.js';
import type { Op } from '../../src/git/segment.js';

export const TEAM_ID = 'team-alpha';
export const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
/** Local wall time the test replicas use for deferring future ops (well after every scenario op). */
export const TEST_NOW = Date.UTC(2026, 9, 17);

export interface Replica {
  store: ReplayStore;
  apply(ops: unknown[], opts?: Partial<ApplyOptions>): ReturnType<typeof applyOps>;
  /** Every replicated table, rows sorted, as one JSON string. */
  dump(): Promise<string>;
  actor(agentId: string): Promise<Actor>;
  close(): Promise<void>;
}

/** A fresh, migrated SQLite replica in a temp dir. `source` defaults to whatever the test registers. */
/** A creator that matches nothing: every createTeam is rejected (used before a team exists). */
export const NO_CREATOR: TeamCreator = { agentId: 'NOCREATOR0', publicKey: 'A'.repeat(43) };

export async function openReplica(
  source: () => unknown[] = () => [], localAgentId?: string, creator: () => TeamCreator | undefined = () => undefined,
): Promise<Replica> {
  const dir = mkdtempSync(join(tmpdir(), 'at-replay-'));
  const db = core.createSqliteDb(join(dir, 'team.db'));
  await core.migrateToLatest(db);
  const store: ReplayStore = { core, ctx: core.createContext(db, { mode: 'local' }) };
  return {
    store,
    apply: (ops, opts = {}) => applyOps(store, ops, {
      source: { allOps: async () => source() }, teamId: TEAM_ID, nowMs: TEST_NOW, teamCreator: creator() ?? NO_CREATOR,
      ...(localAgentId === undefined ? {} : { localAgentId }), ...opts,
    }),
    async dump() {
      const out: Record<string, string[]> = {};
      for (const table of REPLICATED_TABLES) {
        const rows = await db.selectFrom(table).selectAll().execute();
        out[table] = rows.map((r) => JSON.stringify(r)).sort();
      }
      return JSON.stringify(out);
    },
    async actor(agentId) {
      const r = await db.selectFrom('agents').selectAll().where('id', '=', agentId).executeTakeFirstOrThrow();
      return { id: r.id, teamId: r.team_id, name: r.name, member: r.member, tool: r.tool };
    },
    async close() {
      await db.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ScenarioAgent {
  id: string;
  name: string;
  hlc: Hlc;
  publicKey: string;
}

/**
 * Authors ops for several agents against a shared fake wall clock. Every op is also applied to a "live"
 * replica as it is authored (as the author's own machine would), so tests can read real ids from it.
 */
export class Scenario {
  now = T0;
  readonly ops: Op[] = [];
  readonly agents = new Map<string, ScenarioAgent>();
  creator: TeamCreator | undefined;
  private constructor(readonly live: Replica) {}

  static async start(): Promise<Scenario> {
    let scenario: Scenario | undefined;
    const live = await openReplica(() => scenario!.ops, undefined, () => scenario!.creator);
    scenario = new Scenario(live);
    return scenario;
  }

  tick(ms = 1000): void {
    this.now += ms;
  }

  private newHlc(): Hlc {
    const hlc = createHlc(() => this.now);
    // Every agent has seen every earlier op (they sync constantly in this scenario).
    for (const op of this.ops) hlc.observe(op.ts);
    return hlc;
  }

  private async push(op: Op): Promise<Op> {
    this.ops.push(op);
    await this.live.apply([op]);
    return op;
  }

  async createTeam(member: string, tool: 'claude' | 'codex' | 'cursor' = 'claude'): Promise<ScenarioAgent> {
    const hlc = this.newHlc();
    const { publicKey } = newAgentKeyPair();
    const name = `${member}-${tool}`;
    const { agentId, op } = captureBootstrapOp(hlc, 'createTeam', {
      teamId: TEAM_ID, name: 'alpha', repo: { provider: 'local', defaultBranch: 'main' }, member, tool, agentName: name, publicKey,
    });
    const agent = { id: agentId, name, hlc, publicKey };
    this.agents.set(name, agent);
    this.creator = { agentId, publicKey };
    await this.push(op);
    return agent;
  }

  async join(member: string, tool: 'claude' | 'codex' | 'cursor' = 'claude', publicKey = newAgentKeyPair().publicKey): Promise<ScenarioAgent> {
    const hlc = this.newHlc();
    const name = `${member}-${tool}`;
    const { agentId, op } = captureBootstrapOp(hlc, 'join', { teamId: TEAM_ID, member, tool, agentName: name, publicKey });
    const agent = { id: agentId, name, hlc, publicKey };
    this.agents.set(name, agent);
    await this.push(op);
    return agent;
  }

  /** Captures (and live-applies) an op; the author first observes every op so far, like after a sync. */
  async op<N extends RegularOpName>(agent: ScenarioAgent, name: N, input: OpInput<N>, opts: { observe?: boolean } = {}): Promise<Op> {
    if (opts.observe !== false) for (const o of this.ops) agent.hlc.observe(o.ts);
    const directory = await loadAgentDirectory(this.live.store);
    return this.push(captureOp(agent.hlc, agent.id, name, input, directory));
  }

  /** Ids of the messages the agent would currently see as unread on the live replica. */
  async unread(agent: ScenarioAgent): Promise<string[]> {
    const actor = await this.live.actor(agent.id);
    const inbox = await core.readInbox(this.live.store.ctx, actor, { markRead: false });
    return inbox.map((m) => m.id);
  }
}

/** Small deterministic PRNG (mulberry32) for reproducible shuffles. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Splits items into consecutive batches of random size 1..maxBatch. */
export function batches<T>(items: readonly T[], rand: () => number, maxBatch = 5): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length;) {
    const n = 1 + Math.floor(rand() * maxBatch);
    out.push(items.slice(i, i + n));
    i += n;
  }
  return out;
}

export interface Built {
  s: Scenario;
  creator: TeamCreator;
  ops: Op[];
  ronit: ScenarioAgent;
  dylan: ScenarioAgent;
  ash: ScenarioAgent;
  kai: ScenarioAgent;
  createTask1: Op;
  ashClaimFiles: Op;
  claimByDylan: Op;
  claimByKai: Op;
  rejectedCreate: Op;
  sameTsPair: [Op, Op];
}

/**
 * A realistic log: team create, 3 joins, tasks, direct and broadcast messages, reads, claims, commits,
 * an orchestrator change, an orchestrator-only rejection, a claim race, and two ops sharing one ts.
 */
export async function buildLog(): Promise<Built> {
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
  const createTask1 = await s.op(ronit, 'createTask', { title: 'Build the parser', description: 'src/a', assignee: 'dylan-claude' });
  await s.op(ronit, 'createTask', { title: 'Write docs' }); // same ms: HLC counter 1
  s.tick();
  await s.op(dylan, 'claimTask', { task: 1 });
  await s.op(dylan, 'claimFiles', { globs: ['src/a/**'] });
  s.tick();
  const ashClaimFiles = await s.op(ash, 'claimFiles', { globs: ['src/a/x.ts'] }); // conflicts: refused, notice
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
  s.tick();
  // Two agents, one identical ts (same ms, counter 0): neither observed the other.
  const pairA = await s.op(dylan, 'sendMessage', { to: 'all', body: 'same tick from dylan', kind: 'fyi' });
  const pairB = await s.op(kai, 'sendMessage', { to: 'all', body: 'same tick from kai', kind: 'fyi' }, { observe: false });
  return {
    s, creator: s.creator!, ops: [...s.ops], ronit, dylan, ash, kai, createTask1, ashClaimFiles, claimByDylan, claimByKai, rejectedCreate,
    sameTsPair: [pairA, pairB],
  };
}
