/**
 * One sync round for a git team (`agentteams sync`, normally started detached by hooks and MCP):
 *
 *   lock -> fetch -> verify our own remote log (adopt only if it verifies under our key, else restore it)
 *        -> verify + pin the team meta (the creator restores a vandalised meta) -> ingest each agent (chain.ts)
 *        -> applyOps -> presence -> publish own pending ops (CAS) -> push only a verified own chain -> unlock
 *
 * Every per-agent phase is isolated: a failure becomes a refusal for that agent, never a failed round.
 * Refusals are logged and shown once in a hook as a security warning (ruling C4).
 * The lock is owned by a token; ownership is checked before every write phase, and every local ref write is a
 * compare-and-swap (`update-ref <ref> <new> <old>`), so a round paused past its lease cannot corrupt the log.
 *
 * Trust boundary: everything under `.git/agentteams`, `.git/refs/agentteams-*` and `~/.agentteams` belongs to the
 * OS user running agentteams. Logs of other agents of this clone (refs/agentteams-local) are trusted to be
 * fast-forward only (their segments are still verified against pinned keys), because anyone who can write those
 * refs can edit team.db and credentials.json directly. The boundary against teammates is the git remote.
 */
import type { CliDeps } from '../deps.js';
import type { Credential } from '../credentials.js';
import { encodePresence, ingestAgent, short, walkChain } from './chain.js';
import { decodeMeta, encodeMeta, MAX_META_BYTES, metaPin } from './meta.js';
import type { Op } from './ops.js';
import {
  appendSegment, countCommits, fetchTeam, fetchedAgentHead, fetchedMetaObject, isAncestor, listFetchedAgents,
  listLocalAgents, localAgentHead, pushMeta, pushOwn, readFetchedMeta, readLocalMeta, restoreMeta, restoreOwn,
  setFetchedAgentHead, setLocalAgentHead, setPresence, writeMeta,
} from './refs.js';
import { dropLegacy, insertPending, listPending, opKey, removePending } from './replicaStore.js';
import { deferFutureOps, pinAgentKey, pinTeamMeta, rebuildView, type PinResult, type ReplayStore, type TeamCreator } from './replay.js';
import { MAX_OPS_PER_SEGMENT, encodeSegment } from './segment.js';
import {
  acquireLock, clearErrorWarning, fromGit, logSyncError, markSyncWanted, oneLine, readStatus, syncPaths, takeSyncWanted,
  withRefusals, writeStatus, type SyncLock, type SyncStatus,
} from './syncState.js';
import { applyToView, openGitView, replayTarget, teamCreatorOf, type GitView } from './view.js';

export { decodePresence, encodePresence } from './chain.js';

type Deps = Pick<CliDeps, 'exec'>;

export const PRESENCE_INTERVAL_MS = 60_000;
/** Ops per own segment (a segment that still exceeds the byte limit is split). */
const OPS_PER_SEGMENT = 100;
/** Extra rounds run for detached syncs that found the lock held (ruling C7). */
const MAX_EXTRA_ROUNDS = 3;
/** Our own remote log can only ever be ahead of our local one by vandalism: more than this is refused unread. */
const OWN_REMOTE_MAX_EXTRA = 64;
/** Fresh clone: commits of our own remote log adopted per round (the rest next round). */
const OWN_ADOPT_PER_ROUND = 512;

export interface SyncSummary {
  ok: boolean;
  /** 'locked': another round held the lock; 'queued': it did, and will run once more for us (coalesced). */
  skipped?: 'locked' | 'queued';
  fetched: boolean;
  pushed: boolean;
  /** Ops newly verified from the team's refs (including our own log). */
  ingested: number;
  /** Own pending ops appended to our log. */
  published: number;
  applied: number;
  rejected: number;
  backdated: number;
  rebuilt: boolean;
  /** Our remote log was vandalised and restored this round. */
  restored: boolean;
  /** We (the creator) put the team meta back on the remote this round. */
  metaRestored: boolean;
  /** Refused remote data (security): logged, warned once, never fatal. */
  problems: string[];
  /** Failures of the round itself (network, push, internal). */
  errors: string[];
}

/** Test hook: phases after their ownership check, before their writes. */
export type SyncPhase = 'publish';

export interface SyncOptions {
  now?: () => number;
  /** Wait this long for a running round (interactive `sync`). Ignored with `coalesce`. */
  waitMs?: number;
  /** Detached syncs: if a round is running, leave sync.pending for it and exit (ruling C7). */
  coalesce?: boolean;
  /** Tests only: called right after a phase's assertOwned(). */
  onPhase?: (phase: SyncPhase) => Promise<void>;
}

const emptySummary = (): SyncSummary => ({
  ok: true, fetched: false, pushed: false, ingested: 0, published: 0, applied: 0, rejected: 0, backdated: 0, rebuilt: false,
  restored: false, metaRestored: false, problems: [], errors: [],
});

/** Error text for logs and status: one line, control characters stripped, git output labelled. */
export function cleanError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  const g = /^git ([a-z-]+) failed: ([\s\S]*)$/.exec(m);
  return g ? fromGit(g[1]!, g[2]) : oneLine(m);
}

const isFatal = (err: unknown) => err instanceof Error && (err.name === 'LostLockError' || err.name === 'RefMovedError');

// ---- Ingestion ---------------------------------------------------------------------------------------

/** All agents: other clones' logs from fetched refs, this clone's agents from their local refs. */
async function ingestAll(deps: Deps, repo: string, view: GitView, lock: SyncLock, summary: SyncSummary): Promise<Op[]> {
  const { teamId } = view.git;
  const local = new Set(await listLocalAgents(deps, repo, teamId));
  const agents = [...new Set([...local, ...(await listFetchedAgents(deps, repo, teamId))])].sort();
  const ops: Op[] = [];
  for (const agent of agents) {
    try {
      const tip = local.has(agent) ? await localAgentHead(deps, repo, teamId, agent) : await fetchedAgentHead(deps, repo, teamId, agent);
      if (!tip) continue;
      const r = await ingestAgent(deps, repo, view, lock, agent, tip, local.has(agent));
      ops.push(...r.ops);
      summary.problems.push(...r.problems);
    } catch (err) {
      if (isFatal(err)) throw err;
      summary.problems.push(`agent ${agent}: unreadable log (${cleanError(err).slice(0, 160)}); skipped this round`);
    }
  }
  summary.ingested += ops.length;
  return ops;
}

/**
 * Our own log on the remote (ruling C5, review N1/N2): remote commits are adopted only when every one of them
 * verifies under OUR key with contiguous seqs and newer presence, within bounds. Anything else (including a range
 * too large to inspect, or any failure) is vandalism: the local chain is kept and the observed remote tip is
 * returned so the push phase restores our chain with --force-with-lease. Never throws (except a lost lock).
 */
async function checkOwnRemote(deps: Deps, repo: string, view: GitView, lock: SyncLock, summary: SyncSummary): Promise<string | null> {
  const { teamId, agentId } = view.git;
  let fetched: string | null = null;
  try {
    const local = await localAgentHead(deps, repo, teamId, agentId);
    fetched = await fetchedAgentHead(deps, repo, teamId, agentId);
    if (!fetched || local === fetched) return null;
    if (local && (await isAncestor(deps, repo, fetched, local))) return null; // we are ahead (unpushed)
    const state = (await view.files.readLogState()).agents[agentId];
    const base = { agent: agentId, tip: fetched, requireKey: view.git.publicKey, maxSegments: Number.MAX_SAFE_INTEGER };
    if (local && (await isAncestor(deps, repo, local, fetched))) {
      // One agent per clone: nothing beyond our local log can be ours. Bounded by construction.
      const extra = await countCommits(deps, repo, local, fetched);
      if (extra <= OWN_REMOTE_MAX_EXTRA && state?.head === local) {
        const r = await walkChain(deps, repo, view, {
          ...base, from: local, nextSeq: state.nextSeq, presenceMs: state.presenceMs ?? 0, maxCommits: OWN_REMOTE_MAX_EXTRA,
        });
        await lock.assertOwned();
        if (r.complete) {
          await setLocalAgentHead(deps, repo, teamId, agentId, fetched, local);
          return null;
        }
      }
    } else if (!local) {
      // Fresh clone: adopt the verified prefix, a bounded number of commits per round.
      const r = await walkChain(deps, repo, view, { ...base, from: undefined, nextSeq: 0, presenceMs: 0, maxCommits: OWN_ADOPT_PER_ROUND });
      await lock.assertOwned();
      if (r.head) await setLocalAgentHead(deps, repo, teamId, agentId, r.head, null);
      if (r.problems.length === 0) return null; // complete, or capped: continue next round
    }
  } catch (err) {
    if (isFatal(err)) throw err;
    summary.problems.push(`our own log on the remote could not be checked (${cleanError(err).slice(0, 160)})`);
  }
  if (!fetched) return null;
  summary.problems.push(`our own log on the remote was altered (tip ${short(fetched)} is not our verified chain); restoring it`);
  return fetched;
}

// ---- Team meta ---------------------------------------------------------------------------------------

/**
 * Pins the creator from the invite (Task 8): the joiner trusts the invite, not the first meta it sees. A meta
 * whose creator differs from this pin is refused by every round.
 */
export function pinTeamMetaFromInvite(store: ReplayStore, teamId: string, creator: TeamCreator): Promise<PinResult> {
  return pinTeamMeta(store, teamId, { agentId: creator.agentId, publicKey: creator.publicKey });
}

interface MetaCheck {
  creator: TeamCreator | null;
  firstPin: boolean;
  /** Creator only: the remote meta object to replace (vandalised), or 'missing' when the remote has none. */
  repair: string | 'missing' | null;
}

/**
 * Verifies our local meta (we are the creator) and the remote meta, pinning on first sight. A remote meta that is
 * not a valid meta of this team, or names another creator than the pin, is refused; if we are the creator we
 * restore it (the meta is write-once, so a restore is always correct).
 */
async function checkMeta(deps: Deps, repo: string, view: GitView, summary: SyncSummary): Promise<MetaCheck> {
  const { teamId, teamKey } = view.git;
  let firstPin = false;
  let creatorHere = false;
  let repair: MetaCheck['repair'] = null;
  try {
    const localBuf = await readLocalMeta(deps, repo, teamId, MAX_META_BYTES);
    const localMeta = localBuf ? decodeMeta(localBuf, teamKey, teamId) : null;
    if (localMeta) {
      const r = await pinTeamMeta(view.store, teamId, metaPin(localMeta));
      if (r === 'pinned') firstPin = true;
      creatorHere = r !== 'mismatch';
      if (r === 'mismatch') summary.problems.push('team meta (local) names another creator than the pinned one; refused');
    }
    const remoteObj = await fetchedMetaObject(deps, repo, teamId);
    if (!remoteObj) {
      if (creatorHere) repair = 'missing';
    } else {
      const buf = await readFetchedMeta(deps, repo, teamId, MAX_META_BYTES);
      const meta = buf ? decodeMeta(buf, teamKey, teamId) : null;
      let bad = false;
      if (!meta) {
        summary.problems.push('team meta (remote) does not verify; refused');
        bad = true;
      } else {
        const r = await pinTeamMeta(view.store, teamId, metaPin(meta));
        if (r === 'pinned') firstPin = true;
        if (r === 'mismatch') {
          summary.problems.push(`team meta (remote) names creator ${meta.agentId}, not the pinned one; refused`);
          bad = true;
        }
      }
      if (bad && creatorHere) repair = remoteObj;
    }
  } catch (err) {
    summary.problems.push(`team meta could not be checked (${cleanError(err).slice(0, 160)})`);
  }
  return { creator: await teamCreatorOf(view), firstPin, repair };
}

// ---- Apply and presence ------------------------------------------------------------------------------

async function applyIngested(view: GitView, incoming: Op[], creator: TeamCreator, firstPin: boolean, now: () => number, summary: SyncSummary): Promise<void> {
  const { files } = view;
  const candidates = [...(await files.readDeferred()), ...incoming, ...(await listPending(view.store.ctx.db))];
  const { ready, deferred } = deferFutureOps(candidates, now());
  await files.writeDeferred(deferred);
  let r;
  if (firstPin) {
    // Ops ingested before the meta was pinned were stored but never applied: replay everything once.
    const { store, source } = replayTarget(view);
    r = await rebuildView(store, { source, teamCreator: creator, localAgentId: view.git.agentId, teamId: view.git.teamId, nowMs: now() });
  } else {
    r = await applyToView(view, ready, { now, creator });
  }
  summary.applied += r.applied;
  summary.rejected += r.rejected;
  summary.backdated += r.backdated;
  summary.rebuilt ||= r.rebuilt;
}

/** Sets last_seen_at from each agent's last verified presence (never backwards, never in the future). */
async function applyPresence(view: GitView, now: number): Promise<void> {
  for (const [agent, st] of Object.entries((await view.files.readLogState()).agents)) {
    if (!st.presenceMs) continue;
    const iso = new Date(Math.min(st.presenceMs, now)).toISOString();
    await view.store.ctx.db.updateTable('agents').set({ last_seen_at: iso }).where('id', '=', agent)
      .where((eb) => eb.or([eb('last_seen_at', 'is', null), eb('last_seen_at', '<', iso)])).execute();
  }
}

// ---- Own log -----------------------------------------------------------------------------------------

function encodeChunked(view: GitView, firstSeq: number, ops: Op[]): Array<{ seq: number; data: Buffer; ops: Op[] }> {
  const out: Array<{ seq: number; data: Buffer; ops: Op[] }> = [];
  const encode = (batch: Op[]): void => {
    try {
      const seq = firstSeq + out.length;
      out.push({ seq, ops: batch, data: encodeSegment({ teamId: view.git.teamId, agent: view.git.agentId, seq, ops: batch }, view.git.teamKey, view.git.privateKey) });
    } catch (err) {
      if (batch.length <= 1) throw err;
      const half = Math.ceil(batch.length / 2);
      encode(batch.slice(0, half));
      encode(batch.slice(half));
    }
  };
  const step = Math.min(OPS_PER_SEGMENT, MAX_OPS_PER_SEGMENT);
  for (let i = 0; i < ops.length; i += step) encode(ops.slice(i, i + step));
  return out;
}

/** Our local log tip, if (and only if) it is fully verified (the recorded head is the tip). */
async function verifiedOwnTip(deps: Deps, repo: string, view: GitView, lock: SyncLock, summary: SyncSummary): Promise<string | null> {
  const { teamId, agentId } = view.git;
  const tip = await localAgentHead(deps, repo, teamId, agentId);
  if (!tip) return null;
  summary.problems.push(...(await ingestAgent(deps, repo, view, lock, agentId, tip, true)).problems);
  const state = (await view.files.readLogState()).agents[agentId];
  return state?.head === tip ? tip : null;
}

/**
 * Appends our pending ops that are not already in our log as new segments, each a CAS on the verified tip.
 * A crash after an append and before the pending cleanup never publishes an op twice (the log is checked first).
 */
async function publishPending(deps: Deps, repo: string, view: GitView, lock: SyncLock, opts: SyncOptions, summary: SyncSummary): Promise<number> {
  const { files, git } = view;
  const db = view.store.ctx.db;
  const pending = await listPending(db, git.agentId);
  if (pending.length === 0) return 0;
  const tip = await verifiedOwnTip(deps, repo, view, lock, summary);
  if (!tip) throw new Error('this agent\'s own log is not fully verified locally; not publishing (see sync.log)');
  const inLog = new Set((await files.readAccepted(git.agentId)).flatMap((s) => s.ops.map(opKey)));
  await removePending(db, pending.filter((o) => inLog.has(opKey(o))).map((o) => ({ agent: o.agent, id: o.id })));
  const todo = pending.filter((o) => !inLog.has(opKey(o)));
  if (todo.length === 0) return 0;
  const state = (await files.readLogState()).agents[git.agentId]!;
  await lock.assertOwned();
  await opts.onPhase?.('publish');
  let expected = tip;
  for (const seg of encodeChunked(view, state.nextSeq, todo)) {
    await appendSegment(deps, repo, git.teamId, git.agentId, seg.seq, seg.data, expected);
    expected = (await localAgentHead(deps, repo, git.teamId, git.agentId))!;
  }
  // Committed to the local log: no longer pending, whatever happens next.
  await removePending(db, todo.map((o) => ({ agent: o.agent, id: o.id })));
  const r = await ingestAgent(deps, repo, view, lock, git.agentId, expected, true);
  summary.problems.push(...r.problems);
  summary.ingested += r.ops.length;
  return todo.length;
}

async function pushAll(
  deps: Deps, repo: string, view: GitView, lock: SyncLock, status: SyncStatus, restoreFrom: string | null,
  meta: MetaCheck, now: number, summary: SyncSummary,
): Promise<void> {
  const { teamId, agentId, remote } = view.git;
  if (meta.repair === 'missing') {
    const m = await pushMeta(deps, repo, remote, teamId);
    if (!m.ok) summary.errors.push(fromGit('push meta', m.error));
  } else if (meta.repair) {
    const m = await restoreMeta(deps, repo, remote, teamId, meta.repair);
    if (m.ok) summary.metaRestored = true;
    else summary.errors.push(fromGit('restore meta', m.error));
  }
  meta.repair = null;
  const local = await verifiedOwnTip(deps, repo, view, lock, summary);
  if (!local) {
    if (await localAgentHead(deps, repo, teamId, agentId)) summary.errors.push('own log does not verify locally; not pushing it');
    return;
  }
  await lock.assertOwned();
  if (restoreFrom) {
    const r = await restoreOwn(deps, repo, remote, teamId, agentId, restoreFrom);
    if (!r.ok) { summary.errors.push(fromGit('restore', r.error)); return; }
    summary.restored = true;
  } else {
    if (local === (await fetchedAgentHead(deps, repo, teamId, agentId))) return;
    const p = await pushOwn(deps, repo, remote, teamId, agentId);
    if (!p.ok) { summary.errors.push(fromGit('push', p.error)); return; }
  }
  await setFetchedAgentHead(deps, repo, teamId, agentId, local);
  status.lastPushAt = new Date(now).toISOString();
  summary.pushed = true;
}

async function writePresence(deps: Deps, repo: string, view: GitView, lock: SyncLock, status: SyncStatus, now: number, summary: SyncSummary): Promise<void> {
  const due = !status.lastPresenceAt || now - Date.parse(status.lastPresenceAt) >= PRESENCE_INTERVAL_MS;
  if (!due) return;
  const tip = await verifiedOwnTip(deps, repo, view, lock, summary);
  if (!tip) return;
  await lock.assertOwned();
  await setPresence(deps, repo, view.git.teamId, view.git.agentId, encodePresence(view, now), tip);
  status.lastPresenceAt = new Date(now).toISOString();
}

// ---- Migration from the first Task 7 layout -----------------------------------------------------------

async function migrateLegacy(view: GitView): Promise<void> {
  const { pins, pending } = await view.files.takeLegacy();
  if (Object.keys(pins).length === 0 && pending.length === 0) return;
  for (const [agent, key] of Object.entries(pins)) await pinAgentKey(view.store, agent, key).catch(() => undefined);
  const nowIso = new Date().toISOString();
  for (const op of pending) await insertPending(view.store.ctx.db, op, nowIso);
  await dropLegacy(view.files, pending.map((o) => o.id));
}

// ---- The round ---------------------------------------------------------------------------------------

async function runRound(
  deps: Deps, repo: string, view: GitView, lock: SyncLock, status: SyncStatus, now: () => number, opts: SyncOptions, summary: SyncSummary,
): Promise<void> {
  const { teamId, remote, agentId } = view.git;
  await migrateLegacy(view);
  const f = await fetchTeam(deps, repo, remote, teamId);
  let restoreFrom: string | null = null;
  if (f.ok) {
    status.lastFetchAt = new Date(now()).toISOString();
    summary.fetched = true;
    restoreFrom = await checkOwnRemote(deps, repo, view, lock, summary);
  } else {
    summary.errors.push(fromGit('fetch', f.error));
  }
  const meta = await checkMeta(deps, repo, view, summary);
  if (!f.ok) meta.repair = null; // decide repairs only on fresh remote state
  const ingested = await ingestAll(deps, repo, view, lock, summary);
  await lock.assertOwned();
  if (meta.creator) await applyIngested(view, ingested, meta.creator, meta.firstPin, now, summary);
  await applyPresence(view, now());
  for (;;) {
    summary.published += await publishPending(deps, repo, view, lock, opts, summary);
    await writePresence(deps, repo, view, lock, status, now(), summary);
    if (!f.ok) break; // nothing can be pushed; everything stays queued locally
    await pushAll(deps, repo, view, lock, status, restoreFrom, meta, now(), summary);
    restoreFrom = null;
    // Stop as soon as nothing of ours is pending (writes during the round are picked up here) or a push failed.
    if (summary.errors.length > 0 || (await listPending(view.store.ctx.db, agentId)).length === 0) break;
  }
}

/** One locked round: always logs and records its outcome, always releases the lock. */
async function lockedRound(deps: Deps, repo: string, view: GitView, lock: SyncLock, now: () => number, opts: SyncOptions): Promise<SyncSummary> {
  const summary = emptySummary();
  const status: SyncStatus = { ...(await readStatus(view.paths).catch(() => ({}))), lastAttemptAt: new Date(now()).toISOString() };
  let lost = false;
  try {
    await writeStatus(view.paths, status);
    await runRound(deps, repo, view, lock, status, now, opts, summary);
  } catch (err) {
    lost = err instanceof Error && err.name === 'LostLockError';
    summary.errors.push(cleanError(err));
  } finally {
    try {
      for (const p of summary.problems) await logSyncError(view.paths, `refused: ${oneLine(p, 400)}`, now());
      for (const e of summary.errors) await logSyncError(view.paths, oneLine(e, 400), now());
      if (summary.backdated > 0) await logSyncError(view.paths, `${summary.backdated} op(s) arrived late or backdated (view rebuilt)`, now());
      summary.ok = summary.errors.length === 0;
      if (!lost) {
        const base = withRefusals(status, summary.problems.map((p) => oneLine(p)));
        const next: SyncStatus = summary.ok
          ? { ...base, lastError: null }
          : { ...base, lastError: oneLine(summary.errors[0]!), lastErrorAt: new Date(now()).toISOString() };
        await writeStatus(view.paths, next);
        if (summary.ok) await clearErrorWarning(view.paths);
      }
    } catch { /* recording must never mask the round's outcome */ } finally {
      await lock.release();
    }
  }
  return summary;
}

function merge(a: SyncSummary, b: SyncSummary): SyncSummary {
  return {
    ...b,
    fetched: a.fetched || b.fetched, pushed: a.pushed || b.pushed, restored: a.restored || b.restored, rebuilt: a.rebuilt || b.rebuilt,
    metaRestored: a.metaRestored || b.metaRestored,
    ingested: a.ingested + b.ingested, published: a.published + b.published, applied: a.applied + b.applied,
    rejected: a.rejected + b.rejected, backdated: a.backdated + b.backdated,
    problems: [...a.problems, ...b.problems],
  };
}

/** A failure before the lock (bad credential, unreadable repo): still logged and recorded when possible. */
async function recordEarly(deps: Deps, repo: string, err: unknown, now: number): Promise<SyncSummary> {
  const summary = { ...emptySummary(), ok: false, errors: [cleanError(err)] };
  try {
    const paths = await syncPaths(deps, repo);
    await logSyncError(paths, summary.errors[0]!, now);
    await writeStatus(paths, { ...(await readStatus(paths)), lastError: summary.errors[0]!, lastErrorAt: new Date(now).toISOString() });
  } catch { /* nowhere to record */ }
  return summary;
}

/**
 * Runs a round. Never throws: network and remote problems, refusals and internal errors are returned in the
 * summary, written to sync.log and recorded in sync-status.json; pending ops stay queued for the next round.
 */
export async function syncRound(deps: Deps, repo: string, cred: Credential, opts: SyncOptions = {}): Promise<SyncSummary> {
  const now = opts.now ?? Date.now;
  try {
    const view = await openGitView(deps, { ...cred, repoPath: repo });
    let lock = await acquireLock(view.paths.lock, { waitMs: opts.coalesce ? 0 : (opts.waitMs ?? 0) });
    if (!lock) {
      if (!opts.coalesce) return { ...emptySummary(), ok: false, skipped: 'locked' };
      await markSyncWanted(view.paths);
      lock = await acquireLock(view.paths.lock, { waitMs: 0 }); // the holder may have finished meanwhile
      if (!lock) return { ...emptySummary(), skipped: 'queued' };
      await takeSyncWanted(view.paths);
    }
    let summary = await lockedRound(deps, repo, view, lock, now, opts);
    for (let extra = 0; extra < MAX_EXTRA_ROUNDS; extra++) {
      if (!(await takeSyncWanted(view.paths))) break;
      const again = await acquireLock(view.paths.lock, { waitMs: 0 });
      if (!again) break; // a newer round holds it and covers the request
      summary = merge(summary, await lockedRound(deps, repo, view, again, now, opts));
    }
    return summary;
  } catch (err) {
    return recordEarly(deps, repo, err, now());
  }
}

/**
 * Writes this agent's seq-0 bootstrap segment (a createTeam or join op from captureBootstrapOp, alone) to its local
 * log, under the sync lock. A createTeam also writes and pins the signed team meta. The op is applied when the team
 * meta is pinned (always for createTeam; for a join once the meta is pinned, from the invite or a round). Task 8.
 */
export async function writeBootstrap(deps: Deps, repo: string, cred: Credential, op: Op, opts: SyncOptions = {}): Promise<SyncSummary> {
  const now = opts.now ?? Date.now;
  const view = await openGitView(deps, { ...cred, repoPath: repo });
  const { teamId, agentId, teamKey, privateKey, publicKey } = view.git;
  const input = op.input as { publicKey?: unknown; name?: unknown; repo?: { defaultBranch?: unknown } } | null;
  if (op.agent !== agentId || op.id !== agentId || input?.publicKey !== publicKey) throw new Error('bootstrap op does not belong to this credential');
  const lock = await acquireLock(view.paths.lock, { waitMs: opts.waitMs ?? 30_000 });
  if (!lock) throw new Error('another sync is running; try again');
  const summary = emptySummary();
  try {
    if (await localAgentHead(deps, repo, teamId, agentId)) throw new Error('this agent already has a log');
    if (op.op === 'createTeam') {
      const meta = {
        teamId, name: String(input?.name ?? ''), createdAt: new Date(now()).toISOString(),
        defaultBranch: String(input?.repo?.defaultBranch ?? 'main'), agentId, publicKey,
      };
      await writeMeta(deps, repo, teamId, encodeMeta(meta, teamKey, privateKey));
      await pinTeamMeta(view.store, teamId, metaPin({ v: 1, ...meta }));
    }
    await lock.assertOwned();
    await appendSegment(deps, repo, teamId, agentId, 0, encodeSegment({ teamId, agent: agentId, seq: 0, ops: [op] }, teamKey, privateKey), null);
    const r = await ingestAgent(deps, repo, view, lock, agentId, (await localAgentHead(deps, repo, teamId, agentId))!, true);
    if (r.problems.length > 0) throw new Error(r.problems.join('; '));
    summary.ingested = r.ops.length;
    const creator = await teamCreatorOf(view);
    if (creator) await applyIngested(view, r.ops, creator, false, now, summary);
  } finally {
    await lock.release();
  }
  return summary;
}

/** One-line human summary for `agentteams sync`. */
export function formatSyncSummary(s: SyncSummary): string {
  if (s.skipped === 'locked') return 'agentteams: another sync is running; skipped';
  if (s.skipped === 'queued') return 'agentteams: another sync is running; it will run once more for this request';
  const parts = [
    s.fetched ? 'fetched' : 'fetch failed',
    `${s.ingested} op${s.ingested === 1 ? '' : 's'} received`,
    `${s.published} sent`,
    s.pushed ? 'pushed' : null,
    s.restored ? 'own log restored' : null,
    s.metaRestored ? 'team meta restored' : null,
    s.rebuilt ? 'view rebuilt' : null,
    s.problems.length ? `${s.problems.length} refused (see .git/agentteams/sync.log)` : null,
  ].filter(Boolean);
  const head = s.ok ? 'synced' : `sync failed: ${s.errors[0]}`;
  return `agentteams: ${head} (${parts.join(', ')})`;
}
