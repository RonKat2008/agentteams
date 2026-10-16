/**
 * Deterministic replay of the team op log into the local SQLite view.
 *
 * - Ops are applied in total order (ts, agent, id) by calling the real hub services with a replay context:
 *   now() = the op's HLC physical time, newId() = the op id then its successors (ops.ts: opIdSequence).
 * - applied_ops records every op this view has evaluated (applied or rejected) with a content hash.
 * - A batch whose new ops all sort after the last evaluated op is applied incrementally; otherwise (an op
 *   sorts earlier, or a different op reuses a known id) the view is rebuilt: the replicated tables are wiped
 *   and the full op set (OpSource) is replayed. Both paths run in ONE transaction with a savepoint per op,
 *   so a batch is atomic: on an unexpected error everything rolls back and the error is rethrown.
 * - A service DomainError, a zod error or a row-id collision rejects the op (deterministically, on every
 *   replica): its savepoint is rolled back and it is recorded as rejected.
 * - When an op authored by this replica's own agent is rejected, a local notice is stored in
 *   replica_notices. That table (and replica_state) is local, survives rebuilds and is not part of the
 *   replicated view, so every replica's view stays identical; a notice whose op becomes applied after a
 *   rebuild is withdrawn if it was not delivered yet.
 */
import { createHash } from 'node:crypto';
import type { Actor, ControlledTransaction, Database, HubContext, Kysely } from '@agentteams/hub/core';
import { parseHlc } from './hlc.js';
import {
  BOOTSTRAP_OP_NAMES, buildRegistry, canonicalJson, cmp, compareOps, isOpName, opIdMatchesTs, opIdSequence, type Op,
  type OpHandler, type OpName,
} from './ops.js';
import { AGENT_ID_RE } from './segment.js';

type Core = typeof import('@agentteams/hub/core');
type Db = Kysely<Database>;
type Trx = ControlledTransaction<Database>;

export interface ReplayStore {
  readonly core: Core;
  readonly ctx: HubContext;
}

/** Every op this replica knows (all decoded segments). Needed only when the view must be rebuilt. */
export interface OpSource {
  allOps(): Promise<unknown[]>;
}

export interface ApplyOptions {
  source: OpSource;
  /** This replica's own agent: rejections of its ops produce a local notice. */
  localAgentId?: string;
  /** When set, ops for any other team are rejected. */
  teamId?: string;
}

export interface ApplySummary {
  /** Ops evaluated by this call (in a rebuild: the whole log) that changed the view. */
  applied: number;
  /** Ops evaluated by this call that were rejected (including malformed ones). */
  rejected: number;
  /** Incoming ops already in the view (same id and content). */
  duplicates: number;
  rebuilt: boolean;
}

export interface ReplicaNotice {
  opId: string;
  body: string;
  createdAt: string;
}

/** Tables that make up the replicated view, wiped by a rebuild. Not replica_state / replica_notices. */
export const REPLICATED_TABLES = [
  'teams', 'agents', 'messages', 'message_reads', 'tasks', 'claims', 'commits', 'activity', 'agent_keys', 'applied_ops',
] as const satisfies ReadonlyArray<keyof Database>;

const MAX_OP_ID_LENGTH = 64;
const QUERY_CHUNK = 500;
const SAVEPOINT = 'replay_op';

/** An op as received: valid envelopes take part in the total order; invalid ones are only recorded. */
type Candidate =
  | { valid: true; op: Op; hash: string }
  | { valid: false; id: string; agent: string | null; hash: string; error: string };

function hashOf(raw: unknown): string {
  return createHash('sha256').update(canonicalJson(raw) ?? 'undefined').digest('hex');
}

/** Envelope checks. Returns null when the op has no usable id (it cannot even be recorded). */
function classify(raw: unknown): Candidate | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > MAX_OP_ID_LENGTH) return null;
  const hash = hashOf(raw);
  const agent = typeof r.agent === 'string' && AGENT_ID_RE.test(r.agent) ? r.agent : null;
  const invalid = (error: string): Candidate => ({ valid: false, id: r.id as string, agent, hash, error });
  if (r.v !== 1) return invalid('invalid: unsupported op version');
  if (agent === null) return invalid('invalid: malformed agent id');
  if (!parseHlc(r.ts)) return invalid('invalid: malformed timestamp');
  if (!opIdMatchesTs(r.id, r.ts)) return invalid('invalid: op id does not match its timestamp');
  if (typeof r.op !== 'string') return invalid('invalid: malformed op name');
  return { valid: true, op: { v: 1, id: r.id, ts: r.ts as string, agent, op: r.op, input: r.input }, hash };
}

const candidateId = (c: Candidate): string => (c.valid ? c.op.id : c.id);

/** Which of two candidates sharing an id is canonical: valid first, then total order, then hash. */
function rank(a: Candidate, b: Candidate): number {
  if (a.valid !== b.valid) return a.valid ? -1 : 1;
  if (a.valid && b.valid) return compareOps(a.op, b.op) || cmp(a.hash, b.hash);
  return cmp(a.hash, b.hash);
}

function canonicalize(raws: unknown[]): { candidates: Candidate[]; unrecordable: number } {
  const byId = new Map<string, Candidate>();
  let unrecordable = 0;
  for (const raw of raws) {
    const c = classify(raw);
    if (!c) {
      unrecordable++;
      continue;
    }
    const prev = byId.get(candidateId(c));
    if (!prev || rank(c, prev) < 0) byId.set(candidateId(c), c);
  }
  return { candidates: [...byId.values()], unrecordable };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function knownHashes(db: Db, ids: string[]): Promise<Map<string, string>> {
  const known = new Map<string, string>();
  for (const part of chunks(ids, QUERY_CHUNK)) {
    const rows = await db.selectFrom('applied_ops').select(['op_id', 'hash']).where('op_id', 'in', part).execute();
    for (const r of rows) known.set(r.op_id, r.hash);
  }
  return known;
}

async function lastEvaluated(db: Db): Promise<Pick<Op, 'ts' | 'agent' | 'id'> | null> {
  const row = await db.selectFrom('applied_ops').select(['ts', 'agent', 'op_id'])
    .where('ts', 'is not', null)
    .orderBy('ts', 'desc').orderBy('agent', 'desc').orderBy('op_id', 'desc')
    .limit(1).executeTakeFirst();
  return row && row.ts !== null && row.agent !== null ? { ts: row.ts, agent: row.agent, id: row.op_id } : null;
}

/** DomainError, zod validation and row-id collisions reject an op; anything else is corruption. */
function rejectionMessage(core: Core, err: unknown): string | null {
  if (err instanceof core.DomainError) return `${err.code}: ${err.message}`;
  const e = err as { name?: unknown; code?: unknown } | null;
  if (e?.name === 'ZodError' || e?.name === '$ZodError') return 'invalid: input failed validation';
  if (typeof e?.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) return 'conflict: the op collides with existing rows';
  return null;
}

class Replayer {
  private readonly registry: Readonly<Record<OpName, OpHandler>>;
  applied = 0;
  rejected = 0;

  constructor(private readonly store: ReplayStore, private readonly trx: Trx, private readonly opts: ApplyOptions) {
    this.registry = buildRegistry(store.core);
  }

  async evaluate(c: Candidate): Promise<void> {
    if (!c.valid) {
      await this.record({ id: c.id, ts: null, agent: c.agent, hash: c.hash }, 'rejected', c.error);
      return;
    }
    const error = await this.run(c.op);
    await this.record({ id: c.op.id, ts: c.op.ts, agent: c.op.agent, hash: c.hash }, error === null ? 'applied' : 'rejected', error, c.op);
  }

  /** Applies one valid-envelope op inside a savepoint. Returns null on success, else the rejection reason. */
  private async run(op: Op): Promise<string | null> {
    if (!isOpName(op.op)) return `invalid: unknown op "${op.op}"`;
    const bootstrap = BOOTSTRAP_OP_NAMES.has(op.op);
    if (bootstrap && this.opts.teamId !== undefined && (op.input as { teamId?: unknown } | null)?.teamId !== this.opts.teamId) {
      return 'forbidden: op belongs to a different team';
    }
    const actor = bootstrap ? provisionalActor(op.agent) : await this.actorOf(op.agent);
    if (!actor) return 'unauthorized: unknown agent';
    if (!bootstrap && this.opts.teamId !== undefined && actor.teamId !== this.opts.teamId) {
      return 'forbidden: op belongs to a different team';
    }

    const sp = await this.trx.savepoint(SAVEPOINT).execute();
    const ms = parseHlc(op.ts)!.ms;
    const ctx: HubContext = {
      ...this.store.ctx, db: sp, now: () => new Date(ms), newId: opIdSequence(op.id), mode: 'local', joinOuterTx: true,
    };
    try {
      await this.registry[op.op](ctx, actor, op.input);
      await sp.releaseSavepoint(SAVEPOINT).execute();
      return null;
    } catch (err) {
      const reason = rejectionMessage(this.store.core, err);
      if (reason === null) throw err;
      await sp.rollbackToSavepoint(SAVEPOINT).execute();
      await sp.releaseSavepoint(SAVEPOINT).execute();
      return reason;
    }
  }

  private async actorOf(agentId: string): Promise<Actor | null> {
    const row = await this.trx.selectFrom('agents').select(['id', 'team_id', 'name', 'member', 'tool'])
      .where('id', '=', agentId).executeTakeFirst();
    return row ? { id: row.id, teamId: row.team_id, name: row.name, member: row.member, tool: row.tool } : null;
  }

  private async record(
    k: { id: string; ts: string | null; agent: string | null; hash: string },
    status: 'applied' | 'rejected', error: string | null, op?: Op,
  ): Promise<void> {
    await this.trx.insertInto('applied_ops').values({ op_id: k.id, ts: k.ts, agent: k.agent, status, error, hash: k.hash }).execute();
    if (status === 'applied') {
      this.applied++;
      await this.trx.deleteFrom('replica_notices').where('op_id', '=', k.id).where('delivered_at', 'is', null).execute();
      return;
    }
    this.rejected++;
    if (this.opts.localAgentId === undefined || k.agent !== this.opts.localAgentId) return;
    const what = op ? op.op : 'op';
    const at = k.ts ? parseHlc(k.ts) : null;
    await this.trx.insertInto('replica_notices').values({
      op_id: k.id, agent_id: k.agent,
      body: `Your ${what} (op ${k.id}) was rejected by the team log: ${error}`,
      created_at: new Date(at ? at.ms : 0).toISOString(), delivered_at: null,
    }).onConflict((oc) => oc.doNothing()).execute();
  }
}

function provisionalActor(agentId: string): Actor {
  return { id: agentId, teamId: '', name: '', member: '', tool: 'other' };
}

function sortForReplay(candidates: Candidate[]): Candidate[] {
  const valid = candidates.filter((c): c is Extract<Candidate, { valid: true }> => c.valid).sort((a, b) => compareOps(a.op, b.op));
  const invalid = candidates.filter((c) => !c.valid).sort((a, b) => cmp(candidateId(a), candidateId(b)));
  return [...valid, ...invalid];
}

async function wipe(trx: Db): Promise<void> {
  for (const table of REPLICATED_TABLES) await trx.deleteFrom(table).execute();
}

async function bumpRebuilds(trx: Db): Promise<void> {
  const row = await trx.selectFrom('replica_state').select('value').where('key', '=', 'rebuilds').executeTakeFirst();
  const value = String((row ? Number(row.value) : 0) + 1);
  await trx.insertInto('replica_state').values({ key: 'rebuilds', value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value })).execute();
}

/**
 * Applies newly received ops to the view. Duplicates (same id and content) are skipped. Returns what this
 * call did; throws (after rolling the whole batch back) only on unexpected errors, i.e. corruption.
 */
export async function applyOps(store: ReplayStore, ops: unknown[], opts: ApplyOptions): Promise<ApplySummary> {
  if (!Array.isArray(ops)) throw new TypeError('applyOps: ops must be an array');
  const { candidates, unrecordable } = canonicalize(ops);
  const trx = await store.ctx.db.startTransaction().execute();
  try {
    const known = await knownHashes(trx, candidates.map(candidateId));
    const fresh = candidates.filter((c) => !known.has(candidateId(c)));
    const conflicting = candidates.some((c) => known.has(candidateId(c)) && known.get(candidateId(c)) !== c.hash);
    const last = await lastEvaluated(trx);
    const late = last !== null && fresh.some((c) => c.valid && compareOps(c.op, last) <= 0);
    const duplicates = candidates.length - fresh.length;

    let summary: ApplySummary;
    if (conflicting || late) {
      summary = { ...(await replayAll(store, trx, [...(await opts.source.allOps()), ...ops], opts)), duplicates };
    } else {
      const replayer = new Replayer(store, trx, opts);
      for (const c of sortForReplay(fresh)) await replayer.evaluate(c);
      summary = { applied: replayer.applied, rejected: replayer.rejected + unrecordable, duplicates, rebuilt: false };
    }
    await trx.commit().execute();
    return summary;
  } catch (err) {
    await trx.rollback().execute();
    throw err;
  }
}

/** Rebuilds the view from the full op set, atomically. */
export async function rebuildView(store: ReplayStore, opts: ApplyOptions): Promise<ApplySummary> {
  const trx = await store.ctx.db.startTransaction().execute();
  try {
    const summary = await replayAll(store, trx, await opts.source.allOps(), opts);
    await trx.commit().execute();
    return summary;
  } catch (err) {
    await trx.rollback().execute();
    throw err;
  }
}

async function replayAll(store: ReplayStore, trx: Trx, raws: unknown[], opts: ApplyOptions): Promise<ApplySummary> {
  const { candidates, unrecordable } = canonicalize(raws);
  await wipe(trx);
  await bumpRebuilds(trx);
  const replayer = new Replayer(store, trx, opts);
  for (const c of sortForReplay(candidates)) await replayer.evaluate(c);
  return { applied: replayer.applied, rejected: replayer.rejected + unrecordable, duplicates: 0, rebuilt: true };
}

/** Returns this agent's undelivered notices, oldest first, and marks them delivered. */
export async function takeNotices(store: ReplayStore, agentId: string): Promise<ReplicaNotice[]> {
  return store.core.withTx(store.ctx, async (tx) => {
    const rows = await tx.db.selectFrom('replica_notices').select(['op_id', 'body', 'created_at'])
      .where('agent_id', '=', agentId).where('delivered_at', 'is', null).orderBy('op_id').execute();
    if (rows.length > 0) {
      await tx.db.updateTable('replica_notices').set({ delivered_at: tx.now().toISOString() })
        .where('op_id', 'in', rows.map((r) => r.op_id)).execute();
    }
    return rows.map((r) => ({ opId: r.op_id, body: r.body, createdAt: r.created_at }));
  });
}
