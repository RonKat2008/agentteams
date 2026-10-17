/**
 * One sync round for a git team (`agentteams sync`, normally started detached by hooks and MCP):
 *
 *   lock -> fetch -> check our own remote log by path and content (adopt our own remote segments; flag vandalism)
 *        -> verify + pin the team meta (the creator repairs it) -> ingest agents by path, within the round budget
 *        -> applyOps -> presence -> publish own pending ops (CAS) -> push our verified log (leased) -> unlock
 *
 * Replicas never track commit chains: a log is its tip tree, read by path (ingest.ts), so re-created or rewritten
 * commits change nothing. Every per-agent phase is isolated: a failure becomes a refusal for that agent, never a
 * failed round. Refusals are logged and shown once in a hook as a security warning (ruling C4).
 * The lock is owned by a token; ownership is checked before every write phase, and every local ref write is a
 * compare-and-swap (`update-ref <ref> <new> <old>`), so a round paused past its lease cannot corrupt the log.
 * A round is bounded (ingest.ts budget); leftover work sets `morePending`, which queues another round.
 *
 * Trust boundary: everything under `.git/agentteams`, `.git/refs/agentteams-*` and `~/.agentteams` belongs to the
 * OS user running agentteams. Logs of other agents of this clone (refs/agentteams-local) are read unbudgeted (their
 * segments are still verified against pinned keys), because anyone who can write those refs can edit team.db and
 * credentials.json directly. The boundary against teammates is the git remote.
 */
import type { CliDeps } from '../deps.js';
import type { Credential } from '../credentials.js';
import { PRESENCE_BUDGET, SEGMENT_BUDGET, ingestAgents, noteDeletedRefs, type Budget, type IngestTarget } from './ingest.js';
import { parseHlc } from './hlc.js';
import { decodeMeta, encodeMeta, MAX_META_BYTES, metaPin, type TeamMeta } from './meta.js';
import type { Op } from './ops.js';
import { checkOwnRemote, type OwnRemote } from './ownLog.js';
import { encodePresence, nextPresence } from './presence.js';
import {
  appendSegment, deleteRemoteRefs, fetchTeam, fetchedMetaObject, fetchedTips, localAgentHead, localTips, pushMeta, pushOwn, readFetchedMeta,
  readLocalMeta, restoreMeta, setFetchedAgentHead, setPresence, treeOf, writeMeta, type RemoteRef,
} from './refs.js';
import { dropLegacy, insertPending, listPending, opKey, removePending } from './replicaStore.js';
import {
  deferFutureOps, getPinnedTeamMeta, pinAgentKey, pinTeamMeta, rebuildView, type PinResult, type ReplayStore, type TeamCreator,
} from './replay.js';
import { MAX_OPS_PER_SEGMENT, encodeSegment } from './segment.js';
import {
  acquireLock, clearErrorWarning, fromGit, logSyncError, markSyncWanted, oneLine, readStatus, syncPaths, takeSyncWanted,
  withRefusals, writeStatus, type SyncLock, type SyncStatus,
} from './syncState.js';
import { applyToView, openGitView, replayTarget, teamCreatorOf, type GitView } from './view.js';

export { decodePresence, encodePresence } from './presence.js';

type Deps = Pick<CliDeps, 'exec'>;

export const PRESENCE_INTERVAL_MS = 60_000;
/** Ops per own segment (a segment that still exceeds the byte limit is split). */
const OPS_PER_SEGMENT = 100;
/** Extra rounds run for detached syncs that found the lock held, or for work left by a bounded round (ruling C7). */
const MAX_EXTRA_ROUNDS = 3;

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
  /** Our remote log held data that is not ours and was restored this round. */
  restored: boolean;
  /** We (the creator) put the team meta back on the remote this round. */
  metaRestored: boolean;
  /** The round's budget ran out with team data left to read: another round is queued (sync.pending). */
  morePending: boolean;
  /** Locked rounds this call ran (1 + coalesced or continued rounds). */
  rounds: number;
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
  /**
   * Fetch, verify and apply only: no own-log check, meta repair, publish, presence write or push. For a joiner
   * before it has an agent of its own (create/join).
   */
  ingestOnly?: boolean;
  /** Per-round ingest budget (defaults: SEGMENT_BUDGET segments, PRESENCE_BUDGET agent visits). */
  budget?: Budget;
}

const emptySummary = (): SyncSummary => ({
  ok: true, fetched: false, pushed: false, ingested: 0, published: 0, applied: 0, rejected: 0, backdated: 0, rebuilt: false,
  restored: false, metaRestored: false, morePending: false, rounds: 0, problems: [], errors: [],
});

/** Error text for logs and status: one line, control characters stripped, git output labelled. */
export function cleanError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  const g = /^git ([a-z-]+) failed: ([\s\S]*)$/.exec(m);
  return g ? fromGit(g[1]!, g[2]) : oneLine(m);
}

// ---- Ingestion ---------------------------------------------------------------------------------------

/** All agents, within the round budget: other clones' logs from fetched refs, this clone's from local refs. */
async function ingestAll(deps: Deps, repo: string, view: GitView, lock: SyncLock, opts: SyncOptions, summary: SyncSummary): Promise<Op[]> {
  const { teamId } = view.git;
  const [local, fetched] = await Promise.all([localTips(deps, repo, teamId), fetchedTips(deps, repo, teamId)]);
  const agents = [...new Set([...local.keys(), ...fetched.keys()])].sort();
  const targets: IngestTarget[] = agents.map((agent) => (local.has(agent)
    ? { agent, tip: local.get(agent)!, local: true }
    : { agent, tip: fetched.get(agent)!, local: false }));
  const budget: Budget = { ...(opts.budget ?? { segments: SEGMENT_BUDGET, presence: PRESENCE_BUDGET }) };
  const r = await ingestAgents(deps, repo, view, lock, targets, budget);
  summary.problems.push(...r.problems);
  summary.problems.push(...(await noteDeletedRefs(view, lock, new Set(agents))));
  summary.morePending ||= r.morePending;
  summary.ingested += r.ops.length;
  return r.ops;
}

/** Our local log tip, if (and only if) it verifies: every seq present and verified under our key. */
async function verifiedOwnTip(deps: Deps, repo: string, view: GitView, lock: SyncLock | null, summary: SyncSummary): Promise<string | null> {
  const { teamId, agentId } = view.git;
  const tip = await localAgentHead(deps, repo, teamId, agentId);
  if (!tip) return null;
  // Our own ops in this log were applied locally when they were written.
  const r = await ingestAgents(deps, repo, view, lock, [{ agent: agentId, tip, local: true }], null, false);
  summary.problems.push(...r.problems);
  summary.ingested += r.ops.length;
  const state = (await view.files.readLogState()).agents[agentId];
  return state?.doneTip === tip && !state.stuck ? tip : null;
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

/** Our meta as the creator: the local copy if it verifies, else re-encoded from the pin with our key (re-clone). */
async function creatorMeta(deps: Deps, repo: string, view: GitView): Promise<boolean> {
  const { teamId, teamKey, agentId, privateKey, publicKey } = view.git;
  const buf = await readLocalMeta(deps, repo, teamId, MAX_META_BYTES);
  const local = buf ? decodeMeta(buf, teamKey, teamId) : null;
  if (local && local.agentId === agentId && local.publicKey === publicKey) return true;
  const pin = await getPinnedTeamMeta(view.store, teamId);
  let { name, createdAt, defaultBranch } = pin ?? ({} as Record<string, unknown>);
  if (typeof name !== 'string' || typeof createdAt !== 'string' || typeof defaultBranch !== 'string') {
    // Pinned from the credential (no descriptive fields): take them from our own createTeam op (seq 0).
    const op = (await view.files.readAccepted(agentId)).find((sg) => sg.seq === 0)?.ops[0];
    const input = op?.op === 'createTeam' ? (op.input as { name?: unknown; repo?: { defaultBranch?: unknown } } | null) : null;
    const at = op ? parseHlc(op.ts)?.ms : undefined;
    if (!input || typeof input.name !== 'string' || at === undefined) return false;
    ({ name, createdAt, defaultBranch } = { name: input.name, createdAt: new Date(at).toISOString(), defaultBranch: String(input.repo?.defaultBranch ?? 'main') });
  }
  const meta: Omit<TeamMeta, 'v'> = { teamId, name: name as string, createdAt: createdAt as string, defaultBranch: defaultBranch as string, agentId, publicKey };
  await writeMeta(deps, repo, teamId, encodeMeta(meta, teamKey, privateKey));
  return true;
}

/**
 * Verifies our local meta (we are the creator) and the remote meta, pinning on first sight. A remote meta that is
 * not a valid meta of this team, or names another creator than the pin, is refused. If the pin names us (our
 * credential holds the creator's key), we restore it: from our local copy, or re-encoded from the pin after a
 * re-clone (review L4). The meta is write-once, so a restore is always correct.
 */
async function checkMeta(deps: Deps, repo: string, view: GitView, summary: SyncSummary): Promise<MetaCheck> {
  const { teamId, teamKey, agentId, publicKey } = view.git;
  let firstPin = false;
  let repair: MetaCheck['repair'] = null;
  try {
    const localBuf = await readLocalMeta(deps, repo, teamId, MAX_META_BYTES);
    const localMeta = localBuf ? decodeMeta(localBuf, teamKey, teamId) : null;
    if (localMeta) {
      const r = await pinTeamMeta(view.store, teamId, metaPin(localMeta));
      if (r === 'pinned') firstPin = true;
      if (r === 'mismatch') summary.problems.push('team meta (local) names another creator than the pinned one; refused');
    }
    const remoteObj = await fetchedMetaObject(deps, repo, teamId);
    let bad = !remoteObj;
    if (remoteObj) {
      const buf = await readFetchedMeta(deps, repo, teamId, MAX_META_BYTES);
      const meta = buf ? decodeMeta(buf, teamKey, teamId) : null;
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
    }
    const pin = await getPinnedTeamMeta(view.store, teamId);
    const creatorHere = pin?.agentId === agentId && pin.publicKey === publicKey;
    if (bad && creatorHere && (await creatorMeta(deps, repo, view))) repair = remoteObj ?? 'missing';
  } catch (err) {
    summary.problems.push(`team meta could not be checked (${cleanError(err).slice(0, 160)})`);
  }
  return { creator: await teamCreatorOf(view), firstPin, repair };
}

// ---- Apply and presence ------------------------------------------------------------------------------

/**
 * Applies the round's ops. `rebuild`: the view may lack accepted ops (the meta was just pinned, or an earlier apply
 * failed after its ops were accepted), so everything is replayed once. Clears the `unapplied` marker on success.
 */
async function applyIngested(view: GitView, incoming: Op[], creator: TeamCreator, rebuild: boolean, now: () => number, summary: SyncSummary): Promise<void> {
  const { files } = view;
  const candidates = [...(await files.readDeferred()), ...incoming, ...(await listPending(view.store.ctx.db))];
  const { ready, deferred } = deferFutureOps(candidates, now());
  await files.writeDeferred(deferred);
  let r;
  if (rebuild) {
    const { store, source } = replayTarget(view);
    r = await rebuildView(store, { source, teamCreator: creator, localAgentId: view.git.agentId, teamId: view.git.teamId, nowMs: now() });
  } else {
    r = await applyToView(view, ready, { now, creator });
  }
  summary.applied += r.applied;
  summary.rejected += r.rejected;
  summary.backdated += r.backdated;
  summary.rebuilt ||= r.rebuilt;
  await files.setUnapplied(false);
}

/** Sets last_seen_at from each agent's last verified presence (never backwards, never in the future). */
async function applyPresence(view: GitView, now: number): Promise<void> {
  for (const [agent, st] of Object.entries((await view.files.readLogState()).agents)) {
    if (!st.presence) continue;
    const iso = new Date(Math.min(st.presence.ts, now)).toISOString();
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
    expected = await appendSegment(deps, repo, git.teamId, git.agentId, seg.seq, seg.data, expected);
  }
  // Committed to the local log: no longer pending, whatever happens next.
  await removePending(db, todo.map((o) => ({ agent: o.agent, id: o.id })));
  await verifiedOwnTip(deps, repo, view, lock, summary);
  return todo.length;
}

/** Pushes the meta repair and our verified log (leased on the observed remote tip). Returns the new remote view. */
async function pushAll(
  deps: Deps, repo: string, view: GitView, lock: SyncLock, status: SyncStatus, own: OwnRemote,
  meta: MetaCheck, blockers: RemoteRef[], now: number, summary: SyncSummary,
): Promise<OwnRemote> {
  const { teamId, agentId, remote } = view.git;
  await lock.assertOwned();
  if (blockers.length > 0) {
    const d = await deleteRemoteRefs(deps, repo, remote, blockers);
    if (!d.ok) summary.errors.push(fromGit('clear blocking refs', d.error));
  }
  if (meta.repair === 'missing') {
    const m = await pushMeta(deps, repo, remote, teamId);
    if (!m.ok) summary.errors.push(fromGit('push meta', m.error));
  } else if (meta.repair) {
    const m = await restoreMeta(deps, repo, remote, teamId, meta.repair);
    if (m.ok) summary.metaRestored = true;
    else summary.errors.push(fromGit('restore meta', m.error));
  }
  meta.repair = null;
  if (own.conflict) return own;
  const local = await verifiedOwnTip(deps, repo, view, lock, summary);
  if (!local) {
    if (await localAgentHead(deps, repo, teamId, agentId)) summary.errors.push('own log does not verify locally; not pushing it');
    return own;
  }
  const localRoot = await treeOf(deps, repo, local);
  if (localRoot === own.remoteRoot) return own;
  await lock.assertOwned();
  const p = await pushOwn(deps, repo, remote, teamId, agentId, own.observed);
  if (!p.ok) { summary.errors.push(fromGit('push', p.error)); return own; }
  await setFetchedAgentHead(deps, repo, teamId, agentId, local);
  status.lastPushAt = new Date(now).toISOString();
  summary.pushed = true;
  summary.restored ||= own.vandalised;
  return { observed: local, remoteRoot: localRoot, vandalised: false, conflict: null };
}

/** Writes a presence newer than our last one: ts = max(now, last.ts), counter = last.counter + 1 (review R3). */
async function writePresence(deps: Deps, repo: string, view: GitView, lock: SyncLock, status: SyncStatus, now: number, summary: SyncSummary): Promise<void> {
  const due = !status.lastPresenceAt || now - Date.parse(status.lastPresenceAt) >= PRESENCE_INTERVAL_MS;
  if (!due) return;
  const tip = await verifiedOwnTip(deps, repo, view, lock, summary);
  if (!tip) return;
  const last = (await view.files.readLogState()).agents[view.git.agentId]?.presence;
  await lock.assertOwned();
  await setPresence(deps, repo, view.git.teamId, view.git.agentId, encodePresence(view.git, nextPresence(now, last)), tip);
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

// ---- Unexpected remote refs ---------------------------------------------------------------------------

const MAX_IGNORED_REMEMBERED = 200;

/**
 * Refs under the team prefix that are not `meta` or `agents/<canonical id>` are never fetched; each is warned about
 * once. Returns the ones this agent clears from the remote because they block a valid name: the owner clears
 * `agents/<own id>/...`, the creator `refs/agentteams/<team>`, `.../agents` and `.../meta/...`.
 */
async function noteIgnoredRefs(view: GitView, lock: SyncLock, ignored: RemoteRef[], summary: SyncSummary): Promise<RemoteRef[]> {
  const { teamId, agentId, publicKey } = view.git;
  const seen = new Set((await view.files.readLogState()).ignoredRefs ?? []);
  const fresh = ignored.map((r) => oneLine(r.ref, 160)).filter((n) => !seen.has(n));
  for (const n of fresh) summary.problems.push(`ignored an unexpected team ref on the remote: ${JSON.stringify(n)}`);
  if (fresh.length > 0) {
    await lock.assertOwned();
    await view.files.setIgnoredRefs([...seen, ...fresh].slice(-MAX_IGNORED_REMEMBERED));
  }
  const base = `refs/agentteams/${teamId}`;
  const pin = await getPinnedTeamMeta(view.store, teamId);
  const creatorHere = pin?.agentId === agentId && pin.publicKey === publicKey;
  return ignored.filter((r) => r.ref.startsWith(`${base}/agents/${agentId}/`)
    || (creatorHere && (r.ref === base || r.ref === `${base}/agents` || r.ref.startsWith(`${base}/meta/`))));
}

// ---- The round ---------------------------------------------------------------------------------------

async function runRound(
  deps: Deps, repo: string, view: GitView, lock: SyncLock, status: SyncStatus, now: () => number, opts: SyncOptions, summary: SyncSummary,
): Promise<void> {
  const { teamId, remote, agentId } = view.git;
  await migrateLegacy(view);
  const unapplied = (await view.files.readLogState()).unapplied === true;
  // The creator named by our credential is pinned before anything is fetched (review L5).
  const creator = view.git.creator;
  if (creator && (await pinTeamMetaFromInvite(view.store, teamId, creator)) === 'mismatch') {
    summary.problems.push('this clone pinned a different team creator than this credential names; refusing that meta');
  }
  const f = await fetchTeam(deps, repo, remote, teamId);
  let own: OwnRemote = { observed: null, remoteRoot: null, vandalised: false, conflict: null };
  let blockers: RemoteRef[] = [];
  if (f.ok) {
    status.lastFetchAt = new Date(now()).toISOString();
    summary.fetched = true;
    blockers = await noteIgnoredRefs(view, lock, f.ignored ?? [], summary);
    if (!opts.ingestOnly) own = await checkOwnRemote(deps, repo, view, lock, (f.pruned ?? []).includes(`agents/${agentId}`), summary);
  } else {
    summary.errors.push(fromGit('fetch', f.error));
  }
  const meta = await checkMeta(deps, repo, view, summary);
  if (!f.ok || opts.ingestOnly) meta.repair = null; // decide repairs only on fresh remote state
  const ingested = await ingestAll(deps, repo, view, lock, opts, summary);
  await lock.assertOwned();
  if (meta.creator) await applyIngested(view, ingested, meta.creator, meta.firstPin || unapplied, now, summary);
  await applyPresence(view, now());
  if (opts.ingestOnly) return;
  for (;;) {
    summary.published += await publishPending(deps, repo, view, lock, opts, summary);
    await writePresence(deps, repo, view, lock, status, now(), summary);
    if (!f.ok) break; // nothing can be pushed; everything stays queued locally
    own = await pushAll(deps, repo, view, lock, status, own, meta, blockers, now(), summary);
    blockers = [];
    // Stop as soon as nothing of ours is pending (writes during the round are picked up here) or a push failed.
    if (summary.errors.length > 0 || (await listPending(view.store.ctx.db, agentId)).length === 0) break;
  }
}

/** One locked round: always logs and records its outcome, always releases the lock. */
async function lockedRound(deps: Deps, repo: string, view: GitView, lock: SyncLock, now: () => number, opts: SyncOptions): Promise<SyncSummary> {
  const summary = { ...emptySummary(), rounds: 1 };
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
      // Leftover work (budget): queue another round, run by this call's loop or by the next detached sync.
      if (summary.morePending && !lost) await markSyncWanted(view.paths);
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
    rejected: a.rejected + b.rejected, backdated: a.backdated + b.backdated, rounds: a.rounds + b.rounds,
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
 * Runs a round, plus up to MAX_EXTRA_ROUNDS more when a coalesced request or the round's own leftover work queued
 * one (sync.pending; work still left after that stays queued for the next detached sync). Never throws: network and
 * remote problems, refusals and internal errors are returned in the summary, written to sync.log and recorded in
 * sync-status.json; pending ops stay queued for the next round.
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
    const tip = await appendSegment(deps, repo, teamId, agentId, 0, encodeSegment({ teamId, agent: agentId, seq: 0, ops: [op] }, teamKey, privateKey), null);
    const unapplied = (await view.files.readLogState()).unapplied === true;
    const r = await ingestAgents(deps, repo, view, lock, [{ agent: agentId, tip, local: true }], null);
    if (r.problems.length > 0) throw new Error(r.problems.join('; '));
    summary.ingested = r.ops.length;
    const creator = await teamCreatorOf(view);
    if (creator) await applyIngested(view, r.ops, creator, unapplied, now, summary);
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
    s.morePending ? 'more to read next round' : null,
    s.metaRestored ? 'team meta restored' : null,
    s.rebuilt ? 'view rebuilt' : null,
    s.problems.length ? `${s.problems.length} refused (see .git/agentteams/sync.log)` : null,
  ].filter(Boolean);
  const head = s.ok ? 'synced' : `sync failed: ${s.errors[0]}`;
  return `agentteams: ${head} (${parts.join(', ')})`;
}
