/**
 * The local view of a git team (team.db as a materialised view of the op log) and the write path into it.
 *
 * A write (executeOp):
 *   1. captures the op with captureOp (agent names resolved to ids against the view; HLC seeded from everything
 *      this replica has seen);
 *   2. runs the real service once in a throw-away transaction with the replay context, which gives the exact
 *      response replay will produce, rejects invalid calls before anything is stored (as HTTP would) and detects
 *      no-op calls (no row changed), which are not logged;
 *   3. applies it with applyOps and, in the SAME transaction, records it in replica_pending: either the op is
 *      applied locally and queued for publishing, or neither (a rejection rolls both back and is thrown).
 *
 * The write path's applyOps does not take the sync lock: it runs in its own BEGIN IMMEDIATE
 * transaction, never nested, and its OpSource reads pending rows through that same transaction.
 */
import type { Actor, ControlledTransaction, Database, Kysely } from '@agentteams/hub/core';
import type { CliDeps } from '../deps.js';
import type { Credential, GitCredential } from '../credentials.js';
import { HubError } from '../hubClient.js';
import { statusOf } from '../local/localClient.js';
import { openTeamStore, type TeamStore } from '../local/store.js';
import { MAX_CLOCK_SKEW_MS, createHlc, formatHlc, parseHlc, type Hlc } from './hlc.js';
import { buildRegistry, captureOp, rowIdSequence, type Op, type OpInput, type RegularOpName } from './ops.js';
import { insertPending, listPending, replicaFiles, type ReplicaFiles } from './replicaStore.js';
import {
  applyOps, getPinnedTeamMeta, loadAgentDirectory, type ApplySummary, type OpSource, type ReplayStore, type TeamCreator,
} from './replay.js';
import { syncPaths, type SyncPaths } from './syncState.js';

type Deps = Pick<CliDeps, 'exec'>;
type Db = Kysely<Database>;
type Trx = ControlledTransaction<Database>;

export interface GitView {
  store: TeamStore;
  git: GitCredential;
  files: ReplicaFiles;
  paths: SyncPaths;
}

/** The git identity of a credential; throws a clear error when the credential lacks it. */
export function requireGit(cred: Credential): GitCredential {
  const g = cred.git;
  if (cred.transport !== 'git' || !g || !g.teamId || !g.agentId || !g.remote || !g.teamKey || !g.privateKey || !g.publicKey) {
    throw new HubError('unauthorized', 'this git-team credential is incomplete (re-run agentteams join)', 401);
  }
  return g;
}

export async function openGitView(deps: Deps, cred: Credential): Promise<GitView> {
  const git = requireGit(cred);
  const store = await openTeamStore(deps, cred.repoPath);
  const paths = await syncPaths(deps, cred.repoPath);
  return { store, git, files: replicaFiles(paths.dir, git.teamId), paths };
}

/** The agent's actor from its agents row (git agents have no API key). */
export async function actorOf(store: TeamStore, agentId: string): Promise<Actor | null> {
  const r = await store.ctx.db.selectFrom('agents').select(['id', 'team_id', 'name', 'member', 'tool'])
    .where('id', '=', agentId).executeTakeFirst();
  return r ? { id: r.id, teamId: r.team_id, name: r.name, member: r.member, tool: r.tool } : null;
}

export async function requireActor(view: GitView): Promise<Actor> {
  const actor = await actorOf(view.store, view.git.agentId);
  if (!actor) {
    throw new HubError('unauthorized', 'this agent is not in the local team view yet; run "agentteams sync"', 401);
  }
  return actor;
}

/** The creator from the verified, pinned team meta; null until the meta has been seen. */
export async function teamCreatorOf(view: GitView): Promise<TeamCreator | null> {
  const pin = await getPinnedTeamMeta(view.store, view.git.teamId);
  return pin ? { agentId: pin.agentId, publicKey: pin.publicKey } : null;
}

/** Presence heartbeat for this agent's own row (not an op; other replicas learn it from presence.bin). */
export async function heartbeat(store: TeamStore, agentId: string, now: number): Promise<void> {
  await store.ctx.db.updateTable('agents').set({ last_seen_at: new Date(now).toISOString() }).where('id', '=', agentId).execute();
}

/**
 * A clock that is ahead of everything this replica has seen (applied ops and pending ops), ignoring timestamps
 * more than MAX_CLOCK_SKEW_MS ahead of the wall clock, so a new op sorts after what it reacts to.
 */
export async function seededHlc(view: GitView, now: () => number = Date.now): Promise<Hlc> {
  const hlc = createHlc(now);
  const cap = formatHlc(now() + MAX_CLOCK_SKEW_MS, 9999);
  const row = await view.store.ctx.db.selectFrom('applied_ops').select('ts').where('ts', 'is not', null).where('ts', '<=', cap)
    .orderBy('ts', 'desc').limit(1).executeTakeFirst();
  if (row?.ts) hlc.observe(row.ts);
  for (const op of await listPending(view.store.ctx.db)) hlc.observe(op.ts);
  return hlc;
}

/**
 * The replay store for one applyOps call, plus its OpSource. The store records the transaction applyOps opens,
 * so the OpSource reads pending rows through it (SQLite has one connection: reading through the plain db
 * inside that transaction would wait forever), and runs `onCommit` inside the transaction just before it commits.
 */
export function replayTarget(view: GitView, onCommit?: (trx: Trx) => Promise<void>): { store: ReplayStore; source: OpSource } {
  const db = view.store.ctx.db;
  let current: Trx | null = null;
  const bind = <T extends object>(target: T, prop: PropertyKey): unknown => {
    const v = Reflect.get(target, prop, target) as unknown;
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  };
  const wrapTrx = (trx: Trx): Trx => new Proxy(trx, {
    get(t, p) {
      if (p === 'commit') {
        return () => ({
          execute: async () => {
            if (onCommit) await onCommit(t);
            current = null;
            return t.commit().execute();
          },
        });
      }
      if (p === 'rollback') {
        return () => ({ execute: async () => { current = null; return t.rollback().execute(); } });
      }
      return bind(t, p);
    },
  });
  const wrappedDb = new Proxy(db, {
    get(t, p) {
      if (p === 'startTransaction') {
        return () => ({
          execute: async () => {
            const trx = await t.startTransaction().execute();
            current = trx;
            return wrapTrx(trx);
          },
        });
      }
      return bind(t, p);
    },
  }) as Db;
  const store: ReplayStore = { core: view.store.core, ctx: { ...view.store.ctx, db: wrappedDb } };
  const source: OpSource = {
    // Pending first, then accepted: safe against a concurrent move of ops from pending into the log.
    allOps: async () => [...(await listPending(current ?? db)), ...(await view.files.acceptedOps())],
  };
  return { store, source };
}

/** applyOps through replayTarget (team creator from the pinned meta; throws if the meta is not pinned yet). */
export async function applyToView(
  view: GitView, ops: unknown[], opts: { now: () => number; creator: TeamCreator; onCommit?: (trx: Trx) => Promise<void> },
): Promise<ApplySummary> {
  const { store, source } = replayTarget(view, opts.onCommit);
  return applyOps(store, ops, {
    source, teamCreator: opts.creator, localAgentId: view.git.agentId, teamId: view.git.teamId, nowMs: opts.now(),
  });
}

export interface ExecuteResult { result: unknown; op: Op | null }

/** Runs the service in a transaction that is always rolled back. Returns its result and whether any row changed. */
async function trial(view: GitView, actor: Actor, op: Op): Promise<{ result: unknown; changed: boolean }> {
  const { core, ctx } = view.store;
  const trx = await ctx.db.startTransaction().execute();
  try {
    const changes = async () => Number((await core.sql<{ n: number }>`select total_changes() as n`.execute(trx)).rows[0]?.n ?? 0);
    const before = await changes();
    const ms = parseHlc(op.ts)!.ms;
    const replayCtx = {
      ...ctx, db: trx, now: () => new Date(ms), newId: rowIdSequence(op.agent, op.id, op.ts), mode: 'local' as const, joinOuterTx: true,
    };
    const result = await buildRegistry(core)[op.op as RegularOpName](replayCtx, actor, op.input);
    return { result, changed: (await changes()) !== before };
  } finally {
    await trx.rollback().execute();
  }
}

class LocalRejection extends Error {
  constructor(readonly code: string, op: string) {
    super(`the team log rejected this ${op} (${code})`);
  }
}

/**
 * Captures, validates, applies and queues one op by this agent, atomically. Returns the service's response (as
 * replay produces it) and the op, or `op: null` when the call changed nothing (then nothing is logged).
 */
export async function executeOp<N extends RegularOpName>(
  view: GitView, name: N, input: OpInput<N>, now: () => number = Date.now,
): Promise<ExecuteResult> {
  const actor = await requireActor(view);
  const creator = await teamCreatorOf(view);
  if (!creator) throw new HubError('unauthorized', 'the team meta has not been verified yet; run "agentteams sync"', 401);
  let op: Op;
  try {
    op = captureOp(await seededHlc(view, now), view.git.agentId, name, input, await loadAgentDirectory(view.store, view.git.teamId));
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    const missing = /^no agent named /.test(m);
    throw new HubError(missing ? 'not_found' : 'invalid', m, missing ? 404 : 400);
  }
  const { result, changed } = await trial(view, actor, op);
  if (!changed) return { result, op: null };
  try {
    await applyToView(view, [op], {
      now, creator,
      onCommit: async (trx) => {
        const row = await trx.selectFrom('applied_ops').select(['status', 'error'])
          .where('agent', '=', op.agent).where('op_id', '=', op.id).where('status', '=', 'applied').executeTakeFirst();
        if (!row) {
          const rec = await trx.selectFrom('applied_ops').select('error').where('agent', '=', op.agent).where('op_id', '=', op.id).executeTakeFirst();
          throw new LocalRejection(rec?.error ?? 'rejected', op.op);
        }
        await insertPending(trx, op, new Date(now()).toISOString());
      },
    });
  } catch (err) {
    if (err instanceof LocalRejection) throw new HubError(err.code, err.message, STATUS_FALLBACK(err.code));
    throw err;
  }
  return { result, op };
}

const STATUS_FALLBACK = (code: string): number => {
  const s = statusOf(code);
  return s === 500 ? 409 : s;
};

/** `<member>-<tool>`, or the first free `-2`, `-3`, ... suffix in the current view (for joins). */
export async function freeAgentName(store: TeamStore, teamId: string, base: string): Promise<string> {
  const rows = await store.ctx.db.selectFrom('agents').select('name').where('team_id', '=', teamId).execute();
  const taken = new Set(rows.map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
