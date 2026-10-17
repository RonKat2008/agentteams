/**
 * Deterministic replay of the team op log into the local SQLite view.
 *
 * - An op's identity is (agent, id). Different agents can never shadow each other's ops. If one agent
 *   publishes two different ops under one id (equivocation), the variant with a valid envelope and then the
 *   lowest content hash wins on every replica; the others are recorded as rejected with code 'equivocation'
 *   and take no part in ordering, so re-delivering them never triggers another rebuild.
 * - Ops are applied in total order (ts, agent, id) by calling the real hub services with a replay context:
 *   now() = the op's HLC physical time, newId() = row ids derived from (agent, op id) (ops.ts: rowIdSequence).
 * - applied_ops records every op content this view has evaluated (applied or rejected, with a stable code).
 * - A batch whose new ops all sort after the last evaluated op is applied incrementally; otherwise (an op
 *   sorts earlier, or a better equivocation variant arrives) the view is rebuilt: the replicated tables are
 *   wiped and the full op set (OpSource) is replayed. Both paths run in ONE transaction with a savepoint per
 *   op, so a batch is atomic: on an unexpected error everything rolls back and the error is rethrown.
 * - A service DomainError, a zod error or a unique-constraint violation rejects the op (deterministically,
 *   on every replica): its savepoint is rolled back and it is recorded as rejected.
 * - Ops more than MAX_CLOCK_SKEW_MS ahead of local wall time are deferred, never rejected (a wall-clock rule
 *   would diverge between replicas): they are neither applied nor counted for ordering until they are due.
 * - Local-only state that a rebuild never touches: replica_notices (messages for this replica's own agent:
 *   rejections and refused outcomes), replica_state, agent_key_pins and team_meta_pins (trust-on-first-use).
 * - Only the createTeam by the pinned team creator (ApplyOptions.teamCreator, from the meta ref) is accepted.
 * - Residual, accepted risk: an author chooses its ops' HLC ts, so a member can backdate ops to win
 *   order-dependent races (claimTask, claimFiles). Every replica still agrees, and the ops are attributable;
 *   ApplySummary.backdated counts ops that arrive behind the newest applied op so sync can log them.
 */
import { createHash } from 'node:crypto';
import type { Actor, ControlledTransaction, Database, HubContext, Kysely } from '@agentteams/hub/core';
import { isKeyString } from './crypto.js';
import { MAX_CLOCK_SKEW_MS, parseHlc } from './hlc.js';
import {
  type AgentDirectory, BOOTSTRAP_OP_NAMES, OUTCOME_NOTICES, buildRegistry, canonicalJson, cmp, compareOps, isOpName, opIdMatchesTs,
  rowIdSequence, type Op, type OpHandler, type OpName,
} from './ops.js';
import { AGENT_ID_RE } from './segment.js';

type Core = typeof import('@agentteams/hub/core');
type Db = Kysely<Database>;
type Trx = ControlledTransaction<Database>;

export interface ReplayStore {
  readonly core: Core;
  readonly ctx: HubContext;
}

/** Every op this replica has stored (all decoded segments, including deferred ones). Used for rebuilds. */
export interface OpSource {
  allOps(): Promise<unknown[]>;
}

export interface ApplyOptions {
  source: OpSource;
  /** This replica's own agent: rejections and refused outcomes of its ops produce a local notice. */
  localAgentId?: string;
  /**
   * Every agent writing in this clone (they share the view, and a round of one replays the others' pending ops):
   * rejections and refused outcomes of their ops produce a local notice for them too.
   */
  localAgentIds?: readonly string[];
  /** When set, ops for any other team are rejected. */
  teamId?: string;
  /** Local wall time for deferring future ops; defaults to Date.now(). */
  nowMs?: number;
  /**
   * The team creator from the verified, locally pinned meta ref (see pinTeamMeta). Only a createTeam by this
   * agent with this key is accepted; any other createTeam is rejected 'not-creator'.
   */
  teamCreator: TeamCreator;
}

export interface TeamCreator {
  agentId: string;
  publicKey: string;
}

/** The part of a team's meta ref that is pinned; extra fields are stored but not compared. */
export interface TeamMetaPin extends TeamCreator {
  [field: string]: unknown;
}

export interface ApplySummary {
  /** Ops evaluated by this call (in a rebuild: the whole log) that changed the view. */
  applied: number;
  /** Ops evaluated by this call that were rejected (including malformed ones and equivocation losers). */
  rejected: number;
  /** Incoming ops already in the view (same agent, id and content). */
  duplicates: number;
  /** Incoming ops held back because their ts is too far in the future; offer them again later. */
  deferred: number;
  /** New ops that sorted at or before the newest op already applied (late arrivals or backdating). */
  backdated: number;
  rebuilt: boolean;
}

export type PinResult = 'pinned' | 'match' | 'mismatch';

/** Tables that make up the replicated view, wiped by a rebuild. Never the local replica_* or pin tables. */
export const REPLICATED_TABLES = [
  'teams', 'agents', 'messages', 'message_reads', 'tasks', 'claims', 'commits', 'activity', 'agent_keys', 'applied_ops',
] as const satisfies ReadonlyArray<keyof Database>;

/** Stable rejection codes stored in applied_ops.error (besides DomainError codes). */
export const REJECT = {
  malformed: 'malformed',
  equivocation: 'equivocation',
  unknownOp: 'unknown-op',
  unknownAgent: 'unknown-agent',
  wrongTeam: 'wrong-team',
  bootstrapId: 'bootstrap-id',
  pinMismatch: 'pin-mismatch',
  notCreator: 'not-creator',
  validation: 'validation',
  constraint: 'constraint',
} as const;

const MAX_OP_ID_LENGTH = 64;
const QUERY_CHUNK = 500;
const SAVEPOINT = 'replay_op';

// ---- Future ops -----------------------------------------------------------------------------------

/**
 * Splits ops into those due now and those whose ts is more than MAX_CLOCK_SKEW_MS ahead of `nowMs`.
 * Ops with an unparseable ts are "ready" (replay rejects them as malformed).
 */
export function deferFutureOps<T>(ops: readonly T[], nowMs: number): { ready: T[]; deferred: T[] } {
  const ready: T[] = [];
  const deferred: T[] = [];
  for (const op of ops) {
    const t = parseHlc((op as { ts?: unknown } | null)?.ts);
    (t && t.ms > nowMs + MAX_CLOCK_SKEW_MS ? deferred : ready).push(op);
  }
  return { ready, deferred };
}

// ---- Candidates -----------------------------------------------------------------------------------

/** A received op content. Valid envelopes take part in the total order; invalid ones are only recorded. */
type Candidate =
  | { valid: true; agent: string; id: string; hash: string; op: Op; pinned: boolean }
  | { valid: false; agent: string; id: string; hash: string; detail: string; pinned: false };

interface Group {
  winner: Candidate;
  /** Other contents under the same (agent, id): equivocation losers. */
  losers: Candidate[];
}

const keyOf = (c: { agent: string; id: string }): string => `${c.agent}\0${c.id}`;

function hashOf(raw: unknown): string {
  return createHash('sha256').update(canonicalJson(raw) ?? 'undefined').digest('hex');
}

/** Envelope checks. Null when the op has no usable (agent, id): it cannot even be recorded. */
function classify(raw: unknown, pins: ReadonlyMap<string, string>, creator?: TeamCreator): Candidate | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > MAX_OP_ID_LENGTH) return null;
  if (typeof r.agent !== 'string' || !AGENT_ID_RE.test(r.agent)) return null;
  const base = { agent: r.agent, id: r.id, hash: hashOf(raw) };
  const invalid = (detail: string): Candidate => ({ valid: false, ...base, detail, pinned: false });
  if (r.v !== 1) return invalid('unsupported op version');
  if (!parseHlc(r.ts)) return invalid('malformed timestamp');
  if (!opIdMatchesTs(r.id, r.ts)) return invalid('op id does not match its timestamp');
  if (typeof r.op !== 'string') return invalid('malformed op name');
  const pin = pins.get(r.agent);
  const key = (r.input as { publicKey?: unknown } | null)?.publicKey;
  const creatorMatch = r.op === 'createTeam' && creator !== undefined && r.agent === creator.agentId && key === creator.publicKey;
  const pinned = BOOTSTRAP_OP_NAMES.has(r.op) && ((pin !== undefined && pin === key) || creatorMatch);
  return { valid: true, ...base, op: { v: 1, id: r.id, ts: r.ts as string, agent: r.agent, op: r.op, input: r.input }, pinned };
}

/**
 * Equivocation order among contents of one (agent, id): valid envelope first, then (bootstrap ops) the
 * variant whose key matches this replica's pin (or, for createTeam, the pinned team creator), then lowest hash.
 */
function rank(
  a: { valid: boolean; hash: string; pinned: boolean }, b: { valid: boolean; hash: string; pinned: boolean },
): number {
  if (a.valid !== b.valid) return a.valid ? -1 : 1;
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return cmp(a.hash, b.hash);
}

function groupCandidates(
  raws: readonly unknown[], pins: ReadonlyMap<string, string>, creator?: TeamCreator,
): { groups: Map<string, Group>; unrecordable: number; copies: number } {
  const byKey = new Map<string, Map<string, Candidate>>();
  let unrecordable = 0;
  let copies = 0;
  for (const raw of raws) {
    const c = classify(raw, pins, creator);
    if (!c) {
      unrecordable++;
      continue;
    }
    const variants = byKey.get(keyOf(c)) ?? new Map<string, Candidate>();
    if (variants.has(c.hash)) copies++;
    variants.set(c.hash, c);
    byKey.set(keyOf(c), variants);
  }
  const groups = new Map<string, Group>();
  for (const [key, variants] of byKey) {
    const [winner, ...losers] = [...variants.values()].sort(rank);
    groups.set(key, { winner: winner!, losers });
  }
  return { groups, unrecordable, copies };
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface KnownRow { hash: string; ts: string | null; error: string | null }

async function knownRows(db: Db, groups: Map<string, Group>): Promise<Map<string, KnownRow[]>> {
  const ids = [...new Set([...groups.values()].map((g) => g.winner.id))];
  const known = new Map<string, KnownRow[]>();
  for (const part of chunks(ids, QUERY_CHUNK)) {
    const rows = await db.selectFrom('applied_ops').select(['agent', 'op_id', 'hash', 'ts', 'error'])
      .where('op_id', 'in', part).execute();
    for (const r of rows) {
      const key = keyOf({ agent: r.agent, id: r.op_id });
      if (!groups.has(key)) continue;
      known.set(key, [...(known.get(key) ?? []), { hash: r.hash, ts: r.ts, error: r.error }]);
    }
  }
  return known;
}

async function lastEvaluated(db: Db): Promise<Pick<Op, 'ts' | 'agent' | 'id'> | null> {
  const row = await db.selectFrom('applied_ops').select(['ts', 'agent', 'op_id'])
    .where('ts', 'is not', null)
    .orderBy('ts', 'desc').orderBy('agent', 'desc').orderBy('op_id', 'desc')
    .limit(1).executeTakeFirst();
  return row && row.ts !== null ? { ts: row.ts, agent: row.agent, id: row.op_id } : null;
}

/** Stable code for errors that reject an op; null means corruption (rethrow). */
function rejectionOf(core: Core, err: unknown): { code: string; detail: string } | null {
  if (err instanceof core.DomainError) return { code: err.code, detail: err.message };
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (e?.name === 'ZodError' || e?.name === '$ZodError') return { code: REJECT.validation, detail: 'input failed validation' };
  // SQLite unique/constraint violations, and Postgres unique_violation (23505) should replay ever run there.
  if (typeof e?.code === 'string' && (e.code.startsWith('SQLITE_CONSTRAINT') || e.code === '23505')) {
    return { code: REJECT.constraint, detail: 'the op collides with existing rows' };
  }
  return null;
}

type Outcome =
  | { status: 'applied'; notice: string | null }
  | { status: 'rejected'; code: string; detail: string };

class Replayer {
  private readonly registry: Readonly<Record<OpName, OpHandler>>;
  applied = 0;
  rejected = 0;

  constructor(private readonly store: ReplayStore, private readonly trx: Trx, private readonly opts: ApplyOptions) {
    this.registry = buildRegistry(store.core);
  }

  async evaluate(c: Candidate): Promise<void> {
    const outcome: Outcome = c.valid
      ? await this.run(c.op)
      : { status: 'rejected', code: REJECT.malformed, detail: c.detail };
    await this.trx.insertInto('applied_ops').values({
      agent: c.agent, op_id: c.id, hash: c.hash, ts: c.valid ? c.op.ts : null, status: outcome.status,
      error: outcome.status === 'rejected' ? outcome.code : null,
    }).execute();
    const what = c.valid ? c.op.op : 'op';
    if (outcome.status === 'applied') {
      this.applied++;
      if (outcome.notice) await this.notify(c, `Your ${what} (op ${c.id}): ${outcome.notice}`);
      else await this.withdrawNotice(c);
    } else {
      this.rejected++;
      await this.notify(c, `Your ${what} (op ${c.id}) was rejected by the team log: ${outcome.code}: ${outcome.detail}`);
    }
  }

  async recordLoser(c: Candidate): Promise<void> {
    this.rejected++;
    await this.trx.insertInto('applied_ops').values({
      agent: c.agent, op_id: c.id, hash: c.hash, ts: null, status: 'rejected', error: REJECT.equivocation,
    }).execute();
  }

  private reject(code: string, detail: string): Outcome {
    return { status: 'rejected', code, detail };
  }

  /** Applies one valid-envelope op inside a savepoint. */
  private async run(op: Op): Promise<Outcome> {
    if (!isOpName(op.op)) return this.reject(REJECT.unknownOp, `unknown op "${op.op}"`);
    const bootstrap = BOOTSTRAP_OP_NAMES.has(op.op);
    const input = op.input as { teamId?: unknown; agentId?: unknown; publicKey?: unknown } | null;
    if (bootstrap) {
      if (op.id !== op.agent || input?.agentId !== op.agent) {
        return this.reject(REJECT.bootstrapId, 'a bootstrap op must have op id = agent = input.agentId');
      }
      const creator = this.opts.teamCreator;
      if (op.op === 'createTeam' && (op.agent !== creator.agentId || input?.publicKey !== creator.publicKey)) {
        return this.reject(REJECT.notCreator, 'only the team creator named in the team meta can create the team');
      }
      if (this.opts.teamId !== undefined && input?.teamId !== this.opts.teamId) {
        return this.reject(REJECT.wrongTeam, 'op belongs to a different team');
      }
      const pin = await this.trx.selectFrom('agent_key_pins').select('public_key').where('agent_id', '=', op.agent).executeTakeFirst();
      if (pin && pin.public_key !== input?.publicKey) {
        return this.reject(REJECT.pinMismatch, 'the key does not match the key pinned for this agent');
      }
    }
    const actor = bootstrap ? provisionalActor(op.agent) : await this.actorOf(op.agent);
    if (!actor) return this.reject(REJECT.unknownAgent, 'unknown agent');
    if (!bootstrap && this.opts.teamId !== undefined && actor.teamId !== this.opts.teamId) {
      return this.reject(REJECT.wrongTeam, 'op belongs to a different team');
    }

    const sp = await this.trx.savepoint(SAVEPOINT).execute();
    const ms = parseHlc(op.ts)!.ms;
    const ctx: HubContext = {
      ...this.store.ctx, db: sp, now: () => new Date(ms), newId: rowIdSequence(op.agent, op.id, op.ts),
      mode: 'local', joinOuterTx: true,
    };
    try {
      const result = await this.registry[op.op](ctx, actor, op.input);
      await sp.releaseSavepoint(SAVEPOINT).execute();
      return { status: 'applied', notice: OUTCOME_NOTICES[op.op]?.(result, op.input) ?? null };
    } catch (err) {
      const rejection = rejectionOf(this.store.core, err);
      if (rejection === null) throw err;
      await sp.rollbackToSavepoint(SAVEPOINT).execute();
      await sp.releaseSavepoint(SAVEPOINT).execute();
      return this.reject(rejection.code, rejection.detail);
    }
  }

  private async actorOf(agentId: string): Promise<Actor | null> {
    const row = await this.trx.selectFrom('agents').select(['id', 'team_id', 'name', 'member', 'tool'])
      .where('id', '=', agentId).executeTakeFirst();
    return row ? { id: row.id, teamId: row.team_id, name: row.name, member: row.member, tool: row.tool } : null;
  }

  private isLocal(agent: string): boolean {
    return agent === this.opts.localAgentId || (this.opts.localAgentIds?.includes(agent) ?? false);
  }

  private async notify(c: Candidate, body: string): Promise<void> {
    if (!this.isLocal(c.agent)) return;
    const at = c.valid ? parseHlc(c.op.ts) : null;
    await this.trx.insertInto('replica_notices').values({
      agent_id: c.agent, op_id: c.id, body, created_at: new Date(at ? at.ms : 0).toISOString(), delivered_at: null,
    }).onConflict((oc) => oc.columns(['agent_id', 'op_id']).doUpdateSet({ body }).where('replica_notices.delivered_at', 'is', null))
      .execute();
  }

  private async withdrawNotice(c: Candidate): Promise<void> {
    if (!this.isLocal(c.agent)) return;
    await this.trx.deleteFrom('replica_notices')
      .where('agent_id', '=', c.agent).where('op_id', '=', c.id).where('delivered_at', 'is', null).execute();
  }
}

function provisionalActor(agentId: string): Actor {
  return { id: agentId, teamId: '', name: '', member: '', tool: 'other' };
}

/** Valid winners in total order, then invalid ones by (agent, id). */
function sortForReplay(candidates: Candidate[]): Candidate[] {
  const valid = candidates.filter((c): c is Extract<Candidate, { valid: true }> => c.valid).sort((a, b) => compareOps(a.op, b.op));
  const invalid = candidates.filter((c) => !c.valid).sort((a, b) => cmp(a.agent, b.agent) || cmp(a.id, b.id));
  return [...valid, ...invalid];
}

async function wipe(trx: Trx): Promise<void> {
  for (const table of REPLICATED_TABLES) await trx.deleteFrom(table).execute();
}

async function bumpRebuilds(trx: Trx): Promise<void> {
  const row = await trx.selectFrom('replica_state').select('value').where('key', '=', 'rebuilds').executeTakeFirst();
  const value = String((row ? Number(row.value) : 0) + 1);
  await trx.insertInto('replica_state').values({ key: 'rebuilds', value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value })).execute();
}

async function loadPins(db: Db): Promise<Map<string, string>> {
  const rows = await db.selectFrom('agent_key_pins').select(['agent_id', 'public_key']).execute();
  return new Map(rows.map((r) => [r.agent_id, r.public_key]));
}

// ---- Entry points ---------------------------------------------------------------------------------

/**
 * Applies newly received ops to the view. Duplicates are skipped, future ops deferred. Returns what this
 * call did; throws (after rolling the whole batch back) only on unexpected errors, i.e. corruption.
 */
export async function applyOps(store: ReplayStore, ops: unknown[], opts: ApplyOptions): Promise<ApplySummary> {
  if (!Array.isArray(ops)) throw new TypeError('applyOps: ops must be an array');
  const nowMs = opts.nowMs ?? Date.now();
  const { ready, deferred } = deferFutureOps(ops, nowMs);
  const trx = await store.ctx.db.startTransaction().execute();
  try {
    const { groups, unrecordable, copies } = groupCandidates(ready, await loadPins(trx), opts.teamCreator);
    const known = await knownRows(trx, groups);
    const last = await lastEvaluated(trx);
    const fresh: Candidate[] = [];
    const newLosers: Candidate[] = [];
    let duplicates = copies;
    let backdated = 0;
    let rebuild = false;
    for (const [key, group] of groups) {
      const rows = known.get(key);
      if (!rows) {
        fresh.push(group.winner);
        newLosers.push(...group.losers);
        if (group.winner.valid && last !== null && compareOps(group.winner.op, last) <= 0) {
          rebuild = true;
          backdated++;
        }
        continue;
      }
      const winnerRow = rows.find((r) => r.error !== REJECT.equivocation) ?? rows[0]!;
      // A recorded winner's pin status is not stored: a pin-matching newcomer forces a rebuild (rare, converges).
      const recorded = { valid: winnerRow.ts !== null, hash: winnerRow.hash, pinned: false };
      for (const c of [group.winner, ...group.losers]) {
        if (rows.some((r) => r.hash === c.hash)) duplicates++;
        else if (rank(c, recorded) < 0) rebuild = true;
        else newLosers.push(c);
      }
    }

    let summary: ApplySummary;
    if (rebuild) {
      const all = [...(await opts.source.allOps()), ...ready];
      summary = { ...(await replayAll(store, trx, all, { ...opts, nowMs })), duplicates, deferred: deferred.length, backdated };
    } else {
      const replayer = new Replayer(store, trx, opts);
      for (const c of sortForReplay(fresh)) await replayer.evaluate(c);
      for (const c of newLosers) await replayer.recordLoser(c);
      summary = {
        applied: replayer.applied, rejected: replayer.rejected + unrecordable, duplicates, deferred: deferred.length, backdated,
        rebuilt: false,
      };
    }
    await trx.commit().execute();
    return summary;
  } catch (err) {
    await trx.rollback().execute();
    throw err;
  }
}

/** Rebuilds the view from the full op set (minus deferred future ops), atomically. */
export async function rebuildView(store: ReplayStore, opts: ApplyOptions): Promise<ApplySummary> {
  const nowMs = opts.nowMs ?? Date.now();
  const trx = await store.ctx.db.startTransaction().execute();
  try {
    const summary = await replayAll(store, trx, await opts.source.allOps(), { ...opts, nowMs });
    await trx.commit().execute();
    return summary;
  } catch (err) {
    await trx.rollback().execute();
    throw err;
  }
}

async function agentNamesById(trx: Trx): Promise<Map<string, string>> {
  const rows = await trx.selectFrom('agents').select(['id', 'name']).execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * A rebuild can rename agents (a late, earlier join takes a name and pushes the other to `-2`) or drop
 * them. Names are what people and agents type, so tell this replica's agent about every change.
 */
async function noticeRenames(
  trx: Trx, before: Map<string, string>, after: Map<string, string>, opts: ApplyOptions & { nowMs: number },
): Promise<void> {
  if (opts.localAgentId === undefined) return;
  const holderAfter = new Map([...after].map(([id, name]) => [name, id]));
  const createdAt = new Date(opts.nowMs).toISOString();
  for (const [id, oldName] of before) {
    const newName = after.get(id);
    if (newName === oldName) continue;
    const taker = holderAfter.get(oldName);
    const now = newName === undefined ? 'is no longer in the team view' : `is now called "${newName}"`;
    const reused = taker !== undefined && taker !== id ? `; the name "${oldName}" now refers to another agent (${taker})` : '';
    await trx.insertInto('replica_notices').values({
      agent_id: opts.localAgentId, op_id: `rename:${id}:${newName ?? '-'}`,
      body: `Team change: agent "${oldName}" (${id}) ${now}${reused}.`, created_at: createdAt, delivered_at: null,
    }).onConflict((oc) => oc.columns(['agent_id', 'op_id']).doNothing()).execute();
  }
}

async function replayAll(
  store: ReplayStore, trx: Trx, raws: unknown[], opts: ApplyOptions & { nowMs: number },
): Promise<ApplySummary> {
  const { ready, deferred } = deferFutureOps(raws, opts.nowMs);
  const { groups, unrecordable } = groupCandidates(ready, await loadPins(trx), opts.teamCreator);
  const namesBefore = await agentNamesById(trx);
  await wipe(trx);
  await bumpRebuilds(trx);
  const replayer = new Replayer(store, trx, opts);
  const all = [...groups.values()];
  for (const c of sortForReplay(all.map((g) => g.winner))) await replayer.evaluate(c);
  for (const g of all) for (const c of g.losers) await replayer.recordLoser(c);
  await noticeRenames(trx, namesBefore, await agentNamesById(trx), opts);
  return {
    applied: replayer.applied, rejected: replayer.rejected + unrecordable, duplicates: 0, deferred: deferred.length, backdated: 0,
    rebuilt: true,
  };
}

// ---- Keys and pins ----------------------------------------------------------------------------------

/**
 * Pins an agent's signing key on first sight (trust on first use). Never replaces an existing pin.
 * Returns 'pinned' when this call created the pin, 'match' or 'mismatch' against an existing one.
 */
export async function pinAgentKey(store: ReplayStore, agentId: string, key: string): Promise<PinResult> {
  if (!AGENT_ID_RE.test(agentId)) throw new Error('invalid agent id');
  if (!isKeyString(key)) throw new Error('invalid public key');
  const inserted = await store.ctx.db.insertInto('agent_key_pins')
    .values({ agent_id: agentId, public_key: key, pinned_at: new Date().toISOString() })
    .onConflict((oc) => oc.column('agent_id').doNothing())
    .executeTakeFirst();
  if (Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0) return 'pinned';
  return (await getPinnedKey(store, agentId)) === key ? 'match' : 'mismatch';
}

export async function getPinnedKey(store: ReplayStore, agentId: string): Promise<string | undefined> {
  const row = await store.ctx.db.selectFrom('agent_key_pins').select('public_key').where('agent_id', '=', agentId).executeTakeFirst();
  return row?.public_key;
}

/**
 * Pins a team's meta (its creator's agent id and public key) on first sight. Never replaces a pin.
 * Returns 'pinned' when this call created it, 'match' when the creator id and key equal the pinned ones,
 * else 'mismatch'. Other meta fields are stored with the pin but not compared.
 */
export async function pinTeamMeta(store: ReplayStore, teamId: string, meta: TeamMetaPin): Promise<PinResult> {
  if (!AGENT_ID_RE.test(meta.agentId)) throw new Error('invalid creator agent id');
  if (!isKeyString(meta.publicKey)) throw new Error('invalid creator public key');
  const inserted = await store.ctx.db.insertInto('team_meta_pins')
    .values({ team_id: teamId, meta_json: canonicalJson(meta), pinned_at: new Date().toISOString() })
    .onConflict((oc) => oc.column('team_id').doNothing())
    .executeTakeFirst();
  if (Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0) return 'pinned';
  const pinned = await getPinnedTeamMeta(store, teamId);
  return pinned && pinned.agentId === meta.agentId && pinned.publicKey === meta.publicKey ? 'match' : 'mismatch';
}

export async function getPinnedTeamMeta(store: ReplayStore, teamId: string): Promise<TeamMetaPin | undefined> {
  const row = await store.ctx.db.selectFrom('team_meta_pins').select('meta_json').where('team_id', '=', teamId).executeTakeFirst();
  return row ? (JSON.parse(row.meta_json) as TeamMetaPin) : undefined;
}

/** Agent name -> id and task number -> row id over the current view, for captureOp (ops carry ids). */
export async function loadAgentDirectory(store: ReplayStore, teamId?: string): Promise<AgentDirectory> {
  let agents = store.ctx.db.selectFrom('agents').select(['id', 'name']);
  if (teamId !== undefined) agents = agents.where('team_id', '=', teamId);
  let tasks = store.ctx.db.selectFrom('tasks').select(['id', 'number']);
  if (teamId !== undefined) tasks = tasks.where('team_id', '=', teamId);
  const byName = new Map((await agents.execute()).map((r) => [r.name, r.id]));
  const byNumber = new Map((await tasks.execute()).map((r) => [Number(r.number), r.id]));
  return { idOf: (name) => byName.get(name), taskIdOf: (number) => byNumber.get(number) };
}
