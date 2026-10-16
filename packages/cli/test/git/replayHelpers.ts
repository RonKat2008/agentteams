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
import { REPLICATED_TABLES, applyOps, type ApplyOptions, type ReplayStore } from '../../src/git/replay.js';
import type { Op } from '../../src/git/segment.js';

export const TEAM_ID = 'team-alpha';
export const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

export interface Replica {
  store: ReplayStore;
  apply(ops: unknown[], opts?: Partial<ApplyOptions>): ReturnType<typeof applyOps>;
  /** Every replicated table, rows sorted, as one JSON string. */
  dump(): Promise<string>;
  actor(agentId: string): Promise<Actor>;
  close(): Promise<void>;
}

/** A fresh, migrated SQLite replica in a temp dir. `source` defaults to whatever the test registers. */
export async function openReplica(source: () => unknown[] = () => [], localAgentId?: string): Promise<Replica> {
  const dir = mkdtempSync(join(tmpdir(), 'at-replay-'));
  const db = core.createSqliteDb(join(dir, 'team.db'));
  await core.migrateToLatest(db);
  const store: ReplayStore = { core, ctx: core.createContext(db, { mode: 'local' }) };
  return {
    store,
    apply: (ops, opts = {}) => applyOps(store, ops, {
      source: { allOps: async () => source() }, teamId: TEAM_ID,
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
  private constructor(readonly live: Replica) {}

  static async start(): Promise<Scenario> {
    let scenario: Scenario | undefined;
    const live = await openReplica(() => scenario!.ops);
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
    return this.push(captureOp(agent.hlc, agent.id, name, input));
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
