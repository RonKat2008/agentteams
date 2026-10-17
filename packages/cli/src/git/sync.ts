/**
 * One sync round for a git team (`agentteams sync`, normally started detached by hooks and MCP):
 *
 *   lock -> fetch -> verify own remote log (adopt only if verified; else restore it) -> verify + pin team meta
 *        -> ingest each agent's new segments -> applyOps -> presence -> publish own pending ops -> push -> unlock
 *
 * Ingestion rules (per agent ref; one agent's failure never stops the round):
 *   - fast-forward only from the commit of the agent's last ACCEPTED segment (refs `merge-base --is-ancestor`);
 *     a rewrite is refused, and a later restore of the real chain is accepted because it fast-forwards from there;
 *   - the first-parent chain is walked; every commit may only add one `ops/<seq>.bin` or rewrite presence.bin;
 *   - contiguous seqs (a gap halts that agent until filled), at most MAX_SEGMENTS_PER_AGENT per round, blob sizes
 *     checked before reading, reads in batches of READ_BATCH;
 *   - every segment is decrypted and verified against the agent's pinned key; seq 0 is the TOFU bootstrap and its
 *     key is pinned forever (pinAgentKey; a mismatch is refused).
 * Refusals are logged and shown once in a hook as a security warning (ruling C4).
 * The lock is owned by a token; ownership is checked before every write phase (LostLockError aborts).
 */
import type { CliDeps } from '../deps.js';
import type { Credential } from '../credentials.js';
import { decrypt, encrypt, sign, verify } from './crypto.js';
import { decodeMeta, encodeMeta, MAX_META_BYTES, metaPin } from './meta.js';
import type { Op } from './ops.js';
import {
  appendSegment, fetchTeam, fetchedAgentHead, hasFetchedMeta, hasLocalMeta, isAncestor, listFetchedAgents, listLocalAgents,
  localAgentHead, logCommits, pushMeta, pushOwn, readBlobs, readFetchedMeta, readLocalMeta, readPresenceAt, restoreOwn,
  segmentSeqsAt, setFetchedAgentHead, setLocalAgentHead, setPresence, setSeenAgentHead, sizesOf, writeMeta, type LogCommit,
} from './refs.js';
import { dropLegacy, insertPending, listPending, opKey, removePending, type AcceptedSegment } from './replicaStore.js';
import { deferFutureOps, getPinnedKey, pinAgentKey, pinTeamMeta, rebuildView, type TeamCreator } from './replay.js';
import { MAX_OPS_PER_SEGMENT, MAX_SEGMENT_BYTES, decodeSegment, encodeSegment } from './segment.js';
import {
  acquireLock, clearErrorWarning, fromGit, logSyncError, markSyncWanted, readStatus, syncPaths, takeSyncWanted,
  withRefusals, writeStatus, type SyncLock, type SyncStatus,
} from './syncState.js';
import { applyToView, openGitView, replayTarget, teamCreatorOf, type GitView } from './view.js';

type Deps = Pick<CliDeps, 'exec'>;

export const PRESENCE_INTERVAL_MS = 60_000;
/** Segments read per remote agent per round (a backlog drains over several rounds). */
export const MAX_SEGMENTS_PER_AGENT = 32;
/** Blobs per `cat-file --batch` call (32 x 1 MiB would approach the exec buffer). */
const READ_BATCH = 8;
/** Ops per own segment (a segment that still exceeds the byte limit is split). */
const OPS_PER_SEGMENT = 100;
/** Extra rounds run for detached syncs that found the lock held (ruling C7). */
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
  /** Our remote log was vandalised and restored this round. */
  restored: boolean;
  /** Refused remote data (security): logged, warned once, never fatal. */
  problems: string[];
  /** Failures of the round itself (network, push, internal). */
  errors: string[];
}

export interface SyncOptions {
  now?: () => number;
  /** Wait this long for a running round (interactive `sync`). Ignored with `coalesce`. */
  waitMs?: number;
  /** Detached syncs: if a round is running, leave sync.pending for it and exit (ruling C7). */
  coalesce?: boolean;
}

const emptySummary = (): SyncSummary => ({
  ok: true, fetched: false, pushed: false, ingested: 0, published: 0, applied: 0, rejected: 0, backdated: 0, rebuilt: false,
  restored: false, problems: [], errors: [],
});

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const short = (sha: string) => sha.slice(0, 12);

// ---- Presence (encrypted and signed like segments, bound to team and agent) -----------------------

const presenceContext = (teamId: string, agent: string) => Buffer.from(`agentteams-presence-v1\0${teamId}\0${agent}\0`, 'utf8');

export function encodePresence(view: Pick<GitView, 'git'>, atMs: number): Buffer {
  const { teamId, agentId, teamKey, privateKey } = view.git;
  const ctx = presenceContext(teamId, agentId);
  const plaintext = Buffer.from(JSON.stringify({ v: 1, agent: agentId, at: new Date(atMs).toISOString() }), 'utf8');
  return encrypt(teamKey, Buffer.concat([sign(privateKey, Buffer.concat([ctx, plaintext])), plaintext]), ctx);
}

/** The presence time in ms, or null if it does not decrypt, verify or parse. Never throws. */
export function decodePresence(buf: Buffer, teamKey: string, teamId: string, agent: string, publicKey: string): number | null {
  try {
    const ctx = presenceContext(teamId, agent);
    const inner = decrypt(teamKey, buf, ctx);
    if (!inner || inner.length <= 64) return null;
    const plaintext = inner.subarray(64);
    if (!verify(publicKey, Buffer.concat([ctx, plaintext]), inner.subarray(0, 64))) return null;
    const p = JSON.parse(plaintext.toString('utf8')) as { v?: unknown; agent?: unknown; at?: unknown };
    if (p.v !== 1 || p.agent !== agent || typeof p.at !== 'string') return null;
    const at = Date.parse(p.at);
    return Number.isNaN(at) ? null : at;
  } catch {
    return null;
  }
}

// ---- Chain walk (shared by ingestion and own-log verification) ----------------------------------------

interface WalkResult {
  accepted: AcceptedSegment[];
  /** Commit of the last fully accepted state of the chain (null/undefined: nothing new accepted). */
  head: string | undefined;
  nextSeq: number;
  problems: string[];
  /** Everything up to the tip was accepted. */
  complete: boolean;
}

interface WalkOpts {
  agent: string;
  from: string | undefined;
  tip: string;
  nextSeq: number;
  limit: number;
  /** For our own log: every segment must verify under this key (seq 0's bootstrap key included). */
  requireKey?: string;
}

const OPS_FILE_RE = /^ops\/(\d{8})\.bin$/;

/** Walks `from..tip` (first parent), verifying segments in seq order from `nextSeq`. Throws only on git failures. */
async function walkChain(deps: Deps, repo: string, view: GitView, o: WalkOpts): Promise<WalkResult> {
  const problems: string[] = [];
  const who = `agent ${o.agent}`;
  const commits: LogCommit[] = await logCommits(deps, repo, o.from ?? null, o.tip);
  // 1. Which commit adds which seq; stop at the first commit that does anything else.
  const adds = new Map<number, { blob: string; commit: number }>();
  let usable = commits.length;
  scan: for (let i = 0; i < commits.length; i++) {
    for (const ch of commits[i]!.changes) {
      if (ch.path === 'presence.bin' && (ch.status === 'A' || ch.status === 'M')) continue;
      const m = OPS_FILE_RE.exec(ch.path);
      const seq = m ? Number(m[1]) : -1;
      if (!m || ch.status !== 'A' || seq < o.nextSeq || adds.has(seq)) {
        problems.push(`${who}: commit ${short(commits[i]!.sha)} ${ch.status === 'A' ? 'adds' : 'changes'} ${ch.path.slice(0, 80)}; refused`);
        usable = i;
        break scan;
      }
      adds.set(seq, { blob: ch.blob, commit: i });
    }
  }
  // 2. The contiguous run from nextSeq, bounded, verified in order.
  const run: number[] = [];
  for (let s = o.nextSeq; adds.has(s) && run.length < o.limit; s++) run.push(s);
  const accepted: AcceptedSegment[] = [];
  let failed = false;
  for (let i = 0; i < run.length && !failed; i += READ_BATCH) {
    const batch = run.slice(i, i + READ_BATCH);
    const blobs = batch.map((s) => adds.get(s)!.blob);
    const sizes = await sizesOf(deps, repo, blobs);
    const okCount = sizes.findIndex((n) => n > MAX_SEGMENT_BYTES);
    const readable = okCount === -1 ? batch : batch.slice(0, okCount);
    const data = await readBlobs(deps, repo, readable.map((s) => adds.get(s)!.blob));
    for (let j = 0; j < readable.length; j++) {
      const seq = readable[j]!;
      const v = await verifySegment(view, o, seq, data[j]!);
      if (typeof v === 'string') { problems.push(`${who} seq ${seq}: ${v}; refused`); failed = true; break; }
      accepted.push({ seq, ops: v });
    }
    if (!failed && okCount !== -1) {
      problems.push(`${who} seq ${batch[okCount]}: ${sizes[okCount]} bytes exceeds the segment limit; refused`);
      failed = true;
    }
  }
  const nextSeq = o.nextSeq + accepted.length;
  if (!failed && accepted.length < o.limit && adds.size > 0 && [...adds.keys()].some((s) => s >= nextSeq) && !adds.has(nextSeq)) {
    problems.push(`${who}: seq ${nextSeq} is missing; ingestion halted until it arrives`);
  }
  // 3. The newest commit whose additions (and all before it) are all accepted.
  let head: string | undefined;
  for (let i = 0; i < usable; i++) {
    if ([...adds.entries()].every(([seq, a]) => a.commit > i || seq < nextSeq)) head = commits[i]!.sha;
  }
  const complete = problems.length === 0 && usable === commits.length && head === (commits.length ? commits[commits.length - 1]!.sha : undefined);
  return { accepted, head, nextSeq, problems, complete };
}

/** The segment's ops when it verifies (pinning the key at seq 0), else the refusal reason. */
async function verifySegment(view: GitView, o: WalkOpts, seq: number, data: Buffer): Promise<Op[] | string> {
  const { git, store } = view;
  const pinned = seq === 0 ? undefined : (o.requireKey ?? (await getPinnedKey(store, o.agent)));
  if (seq > 0 && pinned === undefined) return 'no pinned key for this agent';
  const r = decodeSegment(data, git.teamKey, { teamId: git.teamId, agent: o.agent, seq }, (id) => (id === o.agent ? pinned : undefined));
  if (!r.ok) return `rejected (${r.reason})`;
  if (seq === 0) {
    if (!r.bootstrapKey) return 'not a bootstrap segment';
    if (o.requireKey !== undefined && r.bootstrapKey !== o.requireKey) return 'bootstrap key is not ours';
    if ((await pinAgentKey(store, o.agent, r.bootstrapKey)) === 'mismatch') return 'bootstrap key differs from the pinned key';
  } else if (o.requireKey !== undefined) {
    const p = await getPinnedKey(store, o.agent);
    if (p !== undefined && p !== o.requireKey) return 'pinned key is not ours';
  }
  return r.segment.ops;
}

// ---- Ingestion ---------------------------------------------------------------------------------------

/** Verifies and stores an agent's new segments up to `tip`. `local`: the log was written in this clone. */
async function ingestAgent(deps: Deps, repo: string, view: GitView, lock: SyncLock | null, agent: string, tip: string, local: boolean): Promise<{ ops: Op[]; problems: string[] }> {
  const { files } = view;
  const prev = (await files.readLogState()).agents[agent] ?? { nextSeq: 0 };
  if (prev.head === tip) return { ops: [], problems: [] };
  if (prev.head && !(await isAncestor(deps, repo, prev.head, tip))) {
    return { ops: [], problems: [`agent ${agent}: non-fast-forward rewrite (${short(prev.head)} -> ${short(tip)}) refused; keeping the accepted chain`] };
  }
  const own = agent === view.git.agentId;
  const r = await walkChain(deps, repo, view, {
    agent, from: prev.head, tip, nextSeq: prev.nextSeq, limit: local ? Number.MAX_SAFE_INTEGER : MAX_SEGMENTS_PER_AGENT,
    ...(own ? { requireKey: view.git.publicKey } : {}),
  });
  await lock?.assertOwned();
  // Crash order: ops first, then the keep-alive ref, then the state that points past them.
  await files.appendAccepted(agent, r.accepted);
  if (r.head && r.head !== prev.head) {
    await setSeenAgentHead(deps, repo, view.git.teamId, agent, r.head);
    await files.setAgentState(agent, { head: r.head, nextSeq: r.nextSeq });
  }
  return { ops: r.accepted.flatMap((s) => s.ops), problems: r.problems };
}

/** All agents: other clones' logs from fetched refs, this clone's agents from their local refs (finding 7). */
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
      if (err instanceof Error && err.name === 'LostLockError') throw err;
      summary.problems.push(`agent ${agent}: unreadable log (${message(err).split('\n')[0]!.slice(0, 160)}); skipped this round`);
    }
  }
  summary.ingested += ops.length;
  return ops;
}

/**
 * Our own log on the remote (finding 1, ruling C5): adopt remote commits only when every new segment verifies
 * under OUR key with contiguous seqs. Anything else is vandalism: keep (or re-seed from) the verified part and
 * return the observed remote tip so the push phase restores our chain with --force-with-lease.
 */
async function checkOwnRemote(deps: Deps, repo: string, view: GitView, lock: SyncLock, summary: SyncSummary): Promise<string | null> {
  const { teamId, agentId } = view.git;
  const [local, fetched] = await Promise.all([localAgentHead(deps, repo, teamId, agentId), fetchedAgentHead(deps, repo, teamId, agentId)]);
  if (!fetched || local === fetched) return null;
  if (local && (await isAncestor(deps, repo, fetched, local))) return null; // we are ahead (unpushed)
  const extends_ = !local || (await isAncestor(deps, repo, local, fetched));
  if (extends_) {
    const state = (await view.files.readLogState()).agents[agentId];
    const from = local ?? undefined;
    const nextSeq = local ? (state?.head === local ? state.nextSeq : (await segmentSeqsAt(deps, repo, local)).length) : 0;
    const r = await walkChain(deps, repo, view, { agent: agentId, from, tip: fetched, nextSeq, limit: Number.MAX_SAFE_INTEGER, requireKey: view.git.publicKey });
    await lock.assertOwned();
    if (r.complete) {
      await setLocalAgentHead(deps, repo, teamId, agentId, fetched);
      return null;
    }
    if (!local && r.head) await setLocalAgentHead(deps, repo, teamId, agentId, r.head);
  }
  summary.problems.push(`our own log on the remote was altered (tip ${short(fetched)} is not our verified chain); restoring it`);
  return fetched;
}

// ---- Team meta ---------------------------------------------------------------------------------------

/** Verifies the local and fetched meta, pins it on first sight; returns the pinned creator and whether it was new. */
async function checkMeta(deps: Deps, repo: string, view: GitView, summary: SyncSummary): Promise<{ creator: TeamCreator | null; firstPin: boolean }> {
  const { teamId, teamKey } = view.git;
  let firstPin = false;
  for (const [where, read] of [['local', readLocalMeta], ['remote', readFetchedMeta]] as const) {
    const buf = await read(deps, repo, teamId, MAX_META_BYTES);
    if (!buf) continue;
    const meta = decodeMeta(buf, teamKey, teamId);
    if (!meta) { summary.problems.push(`team meta (${where}) does not verify; refused`); continue; }
    const r = await pinTeamMeta(view.store, teamId, metaPin(meta));
    if (r === 'mismatch') summary.problems.push(`team meta (${where}) names creator ${meta.agentId}, not the pinned one; refused`);
    if (r === 'pinned') firstPin = true;
  }
  return { creator: await teamCreatorOf(view), firstPin };
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

/** Sets last_seen_at from every accepted agent's presence.bin (never backwards, never in the future). */
async function applyPresence(deps: Deps, repo: string, view: GitView, now: number): Promise<void> {
  const { git, files, store } = view;
  const local = new Set(await listLocalAgents(deps, repo, git.teamId));
  for (const [agent, st] of Object.entries((await files.readLogState()).agents)) {
    const head = local.has(agent) ? await localAgentHead(deps, repo, git.teamId, agent) : st.head;
    const key = await getPinnedKey(store, agent);
    if (!head || !key) continue;
    const blob = await readPresenceAt(deps, repo, head);
    const at = blob ? decodePresence(blob, git.teamKey, git.teamId, agent, key) : null;
    if (at === null) continue;
    const iso = new Date(Math.min(at, now)).toISOString();
    await store.ctx.db.updateTable('agents').set({ last_seen_at: iso }).where('id', '=', agent)
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
 * Appends our pending ops that are not already in our log as new segments. The log is checked first (it was
 * ingested this round): a crash after an append and before the pending cleanup never publishes an op twice.
 */
async function publishPending(deps: Deps, repo: string, view: GitView, lock: SyncLock, summary: SyncSummary): Promise<number> {
  const { files, git } = view;
  const db = view.store.ctx.db;
  const pending = await listPending(db, git.agentId);
  if (pending.length === 0) return 0;
  // Our log as committed locally (presence commits move the tip): verified before anything is appended.
  const tip = await localAgentHead(deps, repo, git.teamId, git.agentId);
  if (tip) summary.problems.push(...(await ingestAgent(deps, repo, view, lock, git.agentId, tip, true)).problems);
  const inLog = new Set((await files.readAccepted(git.agentId)).flatMap((s) => s.ops.map(opKey)));
  const already = pending.filter((o) => inLog.has(opKey(o)));
  await removePending(db, already.map((o) => ({ agent: o.agent, id: o.id })));
  const todo = pending.filter((o) => !inLog.has(opKey(o)));
  if (todo.length === 0) return 0;
  const head = await localAgentHead(deps, repo, git.teamId, git.agentId);
  const state = (await files.readLogState()).agents[git.agentId];
  const seqs = head ? await segmentSeqsAt(deps, repo, head) : [];
  if (seqs[0] !== 0 || !state || state.head !== head || state.nextSeq !== seqs.length || seqs[seqs.length - 1] !== seqs.length - 1) {
    throw new Error('this agent\'s own log is not fully verified locally; not publishing (see sync.log)');
  }
  await lock.assertOwned();
  for (const seg of encodeChunked(view, state.nextSeq, todo)) {
    await appendSegment(deps, repo, git.teamId, git.agentId, seg.seq, seg.data);
  }
  // Committed to the local log: no longer pending, whatever happens next (finding 1).
  await removePending(db, todo.map((o) => ({ agent: o.agent, id: o.id })));
  const r = await ingestAgent(deps, repo, view, lock, git.agentId, (await localAgentHead(deps, repo, git.teamId, git.agentId))!, true);
  summary.problems.push(...r.problems);
  summary.ingested += r.ops.length;
  return todo.length;
}

async function pushAll(deps: Deps, repo: string, view: GitView, status: SyncStatus, restoreFrom: string | null, now: number, summary: SyncSummary): Promise<void> {
  const { teamId, agentId, remote } = view.git;
  if ((await hasLocalMeta(deps, repo, teamId)) && !(await hasFetchedMeta(deps, repo, teamId))) {
    const m = await pushMeta(deps, repo, remote, teamId);
    if (!m.ok) summary.errors.push(fromGit('push meta', m.error));
  }
  const local = await localAgentHead(deps, repo, teamId, agentId);
  if (!local) return;
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

async function runRound(deps: Deps, repo: string, view: GitView, lock: SyncLock, status: SyncStatus, now: () => number, summary: SyncSummary): Promise<void> {
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
  const { creator, firstPin } = await checkMeta(deps, repo, view, summary);
  const ingested = await ingestAll(deps, repo, view, lock, summary);
  await lock.assertOwned();
  if (creator) await applyIngested(view, ingested, creator, firstPin, now, summary);
  await applyPresence(deps, repo, view, now());
  for (;;) {
    summary.published += await publishPending(deps, repo, view, lock, summary);
    const due = !status.lastPresenceAt || now() - Date.parse(status.lastPresenceAt) >= PRESENCE_INTERVAL_MS;
    await lock.assertOwned();
    if (due && (await localAgentHead(deps, repo, teamId, agentId))) {
      await setPresence(deps, repo, teamId, agentId, encodePresence(view, now()));
      status.lastPresenceAt = new Date(now()).toISOString();
    }
    await pushAll(deps, repo, view, status, restoreFrom, now(), summary);
    restoreFrom = null;
    // Stop as soon as nothing of ours is pending (writes during the round are picked up here) or a push failed.
    if (summary.errors.length > 0 || (await listPending(view.store.ctx.db, agentId)).length === 0) break;
  }
}

/** One locked round: always logs and records its outcome, always releases the lock. */
async function lockedRound(deps: Deps, repo: string, view: GitView, lock: SyncLock, now: () => number): Promise<SyncSummary> {
  const summary = emptySummary();
  const status: SyncStatus = { ...(await readStatus(view.paths).catch(() => ({}))), lastAttemptAt: new Date(now()).toISOString() };
  try {
    await writeStatus(view.paths, status);
    await runRound(deps, repo, view, lock, status, now, summary);
  } catch (err) {
    summary.errors.push(message(err).split('\n')[0]!);
  } finally {
    try {
      for (const p of summary.problems) await logSyncError(view.paths, `refused: ${p}`, now());
      for (const e of summary.errors) await logSyncError(view.paths, e, now());
      if (summary.backdated > 0) await logSyncError(view.paths, `${summary.backdated} op(s) arrived late or backdated (view rebuilt)`, now());
      summary.ok = summary.errors.length === 0;
      const base = withRefusals(status, summary.problems);
      const next: SyncStatus = summary.ok
        ? { ...base, lastError: null }
        : { ...base, lastError: summary.errors[0]!, lastErrorAt: new Date(now()).toISOString() };
      await writeStatus(view.paths, next);
      if (summary.ok) await clearErrorWarning(view.paths);
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
    ingested: a.ingested + b.ingested, published: a.published + b.published, applied: a.applied + b.applied,
    rejected: a.rejected + b.rejected, backdated: a.backdated + b.backdated,
    problems: [...a.problems, ...b.problems],
  };
}

/** A failure before the lock (bad credential, unreadable repo): still logged and recorded when possible. */
async function recordEarly(deps: Deps, repo: string, err: unknown, now: number): Promise<SyncSummary> {
  const summary = { ...emptySummary(), ok: false, errors: [message(err).split('\n')[0]!] };
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
    let summary = await lockedRound(deps, repo, view, lock, now);
    for (let extra = 0; extra < MAX_EXTRA_ROUNDS; extra++) {
      if (!(await takeSyncWanted(view.paths))) break;
      const again = await acquireLock(view.paths.lock, { waitMs: 0 });
      if (!again) break; // a newer round holds it and covers the request
      summary = merge(summary, await lockedRound(deps, repo, view, again, now));
    }
    return summary;
  } catch (err) {
    return recordEarly(deps, repo, err, now());
  }
}

/**
 * Writes this agent's seq-0 bootstrap segment (a createTeam or join op from captureBootstrapOp, alone) to its local
 * log, under the sync lock. A createTeam also writes and pins the signed team meta. The op is applied when the team
 * meta is pinned (always for createTeam; for a join once a round has fetched the meta). For create/join (Task 8).
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
    await appendSegment(deps, repo, teamId, agentId, 0, encodeSegment({ teamId, agent: agentId, seq: 0, ops: [op] }, teamKey, privateKey));
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
    s.rebuilt ? 'view rebuilt' : null,
    s.problems.length ? `${s.problems.length} refused (see .git/agentteams/sync.log)` : null,
  ].filter(Boolean);
  const head = s.ok ? 'synced' : `sync failed: ${s.errors[0]}`;
  return `agentteams: ${head} (${parts.join(', ')})`;
}
