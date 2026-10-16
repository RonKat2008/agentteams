/**
 * The local view of a git team (team.db as a materialised view of the op log) and the write path into it.
 *
 * A write (executeOp):
 *   1. captures the op with captureOp (HLC seeded from everything this replica has seen);
 *   2. runs the real service once in a throw-away transaction with the replay context (now = op ts,
 *      newId = op id sequence), which gives the exact response replay will produce, rejects invalid calls
 *      before anything is stored (as HTTP would) and detects no-op calls (no row changed), which are not logged;
 *   3. persists the op as pending (fsync) - from here a crash cannot lose it;
 *   4. applies it with applyOps (incremental: its ts is after everything seen) and returns the response.
 *
 * Deliberate: the write path's applyOps does not take the sync lock (a round holds it across network calls of
 * up to 20 s each, and agent tool calls cannot wait for that). It runs in its own BEGIN IMMEDIATE transaction,
 * never nested, and the OpSource is read inside that transaction (pending first, then accepted), so a
 * concurrent round can neither lose nor double-apply an op.
 */
import type { Actor } from '@agentteams/hub/core';
import type { CliDeps } from '../deps.js';
import type { Credential, GitCredential } from '../credentials.js';
import { HubError } from '../hubClient.js';
import { statusOf } from '../local/localClient.js';
import { openTeamStore, type TeamStore } from '../local/store.js';
import { deferFutureOps } from './compat.js';
import { MAX_CLOCK_SKEW_MS, createHlc, formatHlc, parseHlc, type Hlc } from './hlc.js';
import { buildRegistry, captureOp, opIdSequence, type Op, type OpInput, type RegularOpName } from './ops.js';
import { replicaFiles, type ReplicaFiles } from './replicaStore.js';
import { applyOps, type OpSource } from './replay.js';
import { syncPaths, type SyncPaths } from './syncState.js';

type Deps = Pick<CliDeps, 'exec'>;

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

/** Presence heartbeat for this agent's own row (not an op; other replicas learn it from presence.bin). */
export async function heartbeat(store: TeamStore, agentId: string, now: number): Promise<void> {
  await store.ctx.db.updateTable('agents').set({ last_seen_at: new Date(now).toISOString() }).where('id', '=', agentId).execute();
}

/**
 * A clock that is ahead of everything this replica has seen (applied ops and own pending ops), ignoring
 * timestamps more than MAX_CLOCK_SKEW_MS ahead of the wall clock, so a new op sorts after what it reacts to.
 */
export async function seededHlc(view: GitView, now: () => number = Date.now): Promise<Hlc> {
  const hlc = createHlc(now);
  const cap = formatHlc(now() + MAX_CLOCK_SKEW_MS, 9999);
  const row = await view.store.ctx.db.selectFrom('applied_ops').select('ts').where('ts', 'is not', null).where('ts', '<=', cap)
    .orderBy('ts', 'desc').limit(1).executeTakeFirst();
  if (row?.ts) hlc.observe(row.ts);
  for (const op of await view.files.listPending()) hlc.observe(op.ts);
  return hlc;
}

/** Everything stored locally (pending + accepted), minus ops deferred for being too far in the future. */
export function opSource(files: ReplicaFiles, now: () => number = Date.now): OpSource {
  return { allOps: async () => deferFutureOps(await files.allOps(), now()).ready };
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
    const replayCtx = { ...ctx, db: trx, now: () => new Date(ms), newId: opIdSequence(op.id), mode: 'local' as const, joinOuterTx: true };
    const result = await buildRegistry(core)[op.op as RegularOpName](replayCtx, actor, op.input);
    return { result, changed: (await changes()) !== before };
  } finally {
    await trx.rollback().execute();
  }
}

function rejection(error: string | null): HubError {
  const m = /^([a-z_]+): (.*)$/s.exec(error ?? '');
  return m ? new HubError(m[1]!, m[2]!, statusOf(m[1]!)) : new HubError('internal', error ?? 'the op was rejected', 500);
}

/**
 * Captures, validates, persists and applies one op by this agent. Returns the service's response (as replay
 * produces it) and the op, or `op: null` when the call changed nothing (then nothing is logged).
 */
export async function executeOp<N extends RegularOpName>(
  view: GitView, name: N, input: OpInput<N>, now: () => number = Date.now,
): Promise<ExecuteResult> {
  const actor = await requireActor(view);
  let op: Op;
  try {
    op = captureOp(await seededHlc(view, now), view.git.agentId, name, input);
  } catch (err) {
    throw new HubError('invalid', err instanceof Error ? err.message : String(err), 400);
  }
  const { result, changed } = await trial(view, actor, op);
  if (!changed) return { result, op: null };
  await view.files.persistPending(op);
  await applyOps(view.store, [op], { source: opSource(view.files, now), teamId: view.git.teamId });
  const row = await view.store.ctx.db.selectFrom('applied_ops').select(['status', 'error']).where('op_id', '=', op.id).executeTakeFirst();
  if (row && row.status !== 'applied') throw rejection(row.error);
  return { result, op };
}

/** `<member>-<tool>`, or the first free `-2`, `-3`, ... suffix in the current view (for joins: replay rejects taken names). */
export async function freeAgentName(store: TeamStore, teamId: string, base: string): Promise<string> {
  const rows = await store.ctx.db.selectFrom('agents').select('name').where('team_id', '=', teamId).execute();
  const taken = new Set(rows.map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}
