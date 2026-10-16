/**
 * One sync round for a git team (`agentteams sync`, normally started detached by hooks and MCP):
 *
 *   lock -> fetch -> ingest every agent's new segments -> applyOps -> re-apply presence
 *        -> append own pending ops as a segment (+ presence, at most every 60 s) -> push -> status -> unlock
 *
 * Ingestion rules (per agent ref):
 *   - fast-forward only: the fetched head must descend from the last accepted head (`git merge-base
 *     --is-ancestor`); a rewrite is rejected and logged, and the previously accepted chain stays authoritative;
 *   - contiguous: seq 0, 1, 2, ...; a gap stops that agent's ingestion until it is filled;
 *   - every blob's size is checked before it is read (refs.readSegmentsAt), max MAX_SEGMENT_BYTES;
 *   - segments are decrypted and verified against the agent's pinned key; seq 0 is the TOFU bootstrap and its
 *     key is pinned forever (a seq 0 whose key differs from the pin is rejected).
 * Verified segments are stored in replica/<team>/accepted, the OpSource for rebuilds. applyOps runs under the
 * sync lock, outside any other transaction.
 */
import type { CliDeps } from '../deps.js';
import type { Credential } from '../credentials.js';
import { decrypt, encrypt, sign, verify } from './crypto.js';
import { deferFutureOps, pinStoreFor } from './compat.js';
import {
  appendSegment, fetchTeam, fetchedAgentHead, hasFetchedMeta, hasLocalMeta, isAncestor, listFetchedAgents, localAgentHead,
  pushMeta, pushOwn, readPresenceAt, readSegmentsAt, segmentSeqsAt, setFetchedAgentHead, setLocalAgentHead, setPresence,
  setSeenAgentHead,
} from './refs.js';
import type { AcceptedSegment } from './replicaStore.js';
import { applyOps } from './replay.js';
import { MAX_OPS_PER_SEGMENT, decodeSegment, encodeSegment, type Op } from './segment.js';
import { acquireLock, logSyncError, readStatus, writeStatus, type SyncStatus } from './syncState.js';
import { opSource, openGitView, type GitView } from './view.js';

type Deps = Pick<CliDeps, 'exec'>;

export const PRESENCE_INTERVAL_MS = 60_000;
/** Ops per own segment (well under MAX_OPS_PER_SEGMENT; a segment that still exceeds the byte limit is split). */
const OPS_PER_SEGMENT = 100;
/** Extra publish/push passes for ops written while a round was running. */
const MAX_PUBLISH_PASSES = 3;

export interface SyncSummary {
  ok: boolean;
  /** Set when another round held the lock and this one did not run. */
  skipped?: 'locked';
  fetched: boolean;
  pushed: boolean;
  /** Ops newly verified from the team's refs (including our own re-read log). */
  ingested: number;
  /** Own pending ops appended to our log this round. */
  published: number;
  applied: number;
  rejected: number;
  rebuilt: boolean;
  /** Refused input from the remote (rewrites, gaps, bad segments): logged, not fatal. */
  problems: string[];
  /** Failures of the round itself (network, push, internal). */
  errors: string[];
}

export interface SyncOptions {
  now?: () => number;
  /** Wait this long for a running round to finish (detached syncs wait; default 0 = skip). */
  waitMs?: number;
}

const emptySummary = (): SyncSummary => ({
  ok: true, fetched: false, pushed: false, ingested: 0, published: 0, applied: 0, rejected: 0, rebuilt: false, problems: [], errors: [],
});

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

// ---- Ingestion -------------------------------------------------------------------------------------

interface Ingested { ops: Op[]; problems: string[] }

/** Verifies and stores the agent's new segments up to `head`. Never throws on bad remote data. */
async function ingestAgent(deps: Deps, repo: string, view: GitView, agent: string, head: string): Promise<Ingested> {
  const { files, git } = view;
  const pins = pinStoreFor(files);
  const prev = (await files.readLogState()).agents[agent] ?? { nextSeq: 0 };
  const problems: string[] = [];
  const short = (sha: string) => sha.slice(0, 12);
  if (prev.head && prev.head !== head && !(await isAncestor(deps, repo, prev.head, head))) {
    return { ops: [], problems: [`agent ${agent}: non-fast-forward rewrite (${short(prev.head)} -> ${short(head)}) rejected; keeping the accepted chain`] };
  }
  const accepted: AcceptedSegment[] = [];
  let expected = prev.nextSeq;
  for (const s of await readSegmentsAt(deps, repo, head, prev.nextSeq)) {
    const at = `agent ${agent} seq ${s.seq}`;
    if (s.seq !== expected) { problems.push(`agent ${agent}: seq ${expected} is missing; ingestion halted until it arrives`); break; }
    if (s.data === null) { problems.push(`${at}: ${s.size} bytes exceeds the segment limit; rejected`); break; }
    const pinned = s.seq === 0 ? undefined : await pins.get(agent);
    if (s.seq > 0 && pinned === undefined) { problems.push(`${at}: no pinned key for this agent; rejected`); break; }
    const r = decodeSegment(s.data, git.teamKey, { teamId: git.teamId, agent, seq: s.seq }, (id) => (id === agent ? pinned : undefined));
    if (!r.ok) { problems.push(`${at}: rejected (${r.reason})`); break; }
    if (s.seq === 0) {
      if (!r.bootstrapKey || (await pins.pin(agent, r.bootstrapKey)) === 'mismatch') {
        problems.push(`${at}: bootstrap key differs from the pinned key; rejected`);
        break;
      }
    }
    accepted.push({ seq: s.seq, ops: r.segment.ops });
    expected++;
  }
  // Order matters for crash safety: ops first, then the keep-alive ref, then the state that points past them.
  await files.appendAccepted(agent, accepted);
  await setSeenAgentHead(deps, repo, git.teamId, agent, head);
  const state = await files.readLogState();
  await files.writeLogState({ ...state, agents: { ...state.agents, [agent]: { head, nextSeq: expected } } });
  return { ops: accepted.flatMap((s) => s.ops), problems };
}

/** Makes our local log at least as new as the fetched copy (fresh clone, or a log pushed from elsewhere). */
async function reseedOwnLog(deps: Deps, repo: string, view: GitView): Promise<void> {
  const { teamId, agentId } = view.git;
  const [local, fetched] = await Promise.all([localAgentHead(deps, repo, teamId, agentId), fetchedAgentHead(deps, repo, teamId, agentId)]);
  if (!fetched || local === fetched) return;
  if (!local || (await isAncestor(deps, repo, local, fetched))) {
    await setLocalAgentHead(deps, repo, teamId, agentId, fetched);
    return;
  }
  if (!(await isAncestor(deps, repo, fetched, local))) throw new Error('this agent\'s log on the remote diverged from the local one');
}

async function ingestAll(deps: Deps, repo: string, view: GitView, summary: SyncSummary): Promise<Op[]> {
  const { teamId, agentId } = view.git;
  const ops: Op[] = [];
  const heads = new Map<string, string>();
  for (const agent of await listFetchedAgents(deps, repo, teamId)) {
    if (agent === agentId) continue;
    const head = await fetchedAgentHead(deps, repo, teamId, agent);
    if (head) heads.set(agent, head);
  }
  const own = await localAgentHead(deps, repo, teamId, agentId);
  if (own) heads.set(agentId, own);
  for (const [agent, head] of heads) {
    const r = await ingestAgent(deps, repo, view, agent, head);
    ops.push(...r.ops);
    summary.problems.push(...r.problems);
  }
  summary.ingested += ops.length;
  return ops;
}

// ---- Apply and presence ----------------------------------------------------------------------------

async function applyIngested(view: GitView, incoming: Op[], now: () => number, summary: SyncSummary): Promise<void> {
  const { ready, deferred } = deferFutureOps([...(await view.files.readDeferred()), ...incoming, ...(await view.files.listPending())], now());
  await view.files.writeDeferred(deferred);
  const r = await applyOps(view.store, ready, { source: opSource(view.files, now), localAgentId: view.git.agentId, teamId: view.git.teamId });
  summary.applied += r.applied;
  summary.rejected += r.rejected;
  summary.rebuilt ||= r.rebuilt;
}

/** Sets last_seen_at from every accepted agent's presence.bin (never backwards, never in the future). */
async function applyPresence(deps: Deps, repo: string, view: GitView, now: number): Promise<void> {
  const { git, files, store } = view;
  const state = await files.readLogState();
  const pins = pinStoreFor(files);
  for (const [agent, st] of Object.entries(state.agents)) {
    const head = agent === git.agentId ? await localAgentHead(deps, repo, git.teamId, agent) : st.head;
    const key = await pins.get(agent);
    if (!head || !key) continue;
    const blob = await readPresenceAt(deps, repo, head);
    const at = blob ? decodePresence(blob, git.teamKey, git.teamId, agent, key) : null;
    if (at === null) continue;
    const iso = new Date(Math.min(at, now)).toISOString();
    await store.ctx.db.updateTable('agents').set({ last_seen_at: iso }).where('id', '=', agent)
      .where((eb) => eb.or([eb('last_seen_at', 'is', null), eb('last_seen_at', '<', iso)])).execute();
  }
}

// ---- Own log ---------------------------------------------------------------------------------------

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
  for (let i = 0; i < ops.length; i += Math.min(OPS_PER_SEGMENT, MAX_OPS_PER_SEGMENT)) encode(ops.slice(i, i + OPS_PER_SEGMENT));
  return out;
}

/** Appends pending ops (not already in our log) as new segments, re-ingests our log, then drops them from pending. */
async function publishPending(deps: Deps, repo: string, view: GitView, summary: SyncSummary): Promise<number> {
  const { files, git } = view;
  const inLog = new Set((await files.readAccepted(git.agentId)).flatMap((s) => s.ops.map((o) => o.id)));
  const pending = (await files.listPending()).filter((o) => o.agent === git.agentId);
  const already = pending.filter((o) => inLog.has(o.id)).map((o) => o.id);
  await files.removePending(already); // a crash after the commit but before the cleanup
  const todo = pending.filter((o) => !inLog.has(o.id));
  if (todo.length === 0) return 0;
  const head = await localAgentHead(deps, repo, git.teamId, git.agentId);
  const seqs = head ? await segmentSeqsAt(deps, repo, head) : [];
  if (seqs[0] !== 0) throw new Error('this agent has no seq-0 join segment in its log; re-run agentteams join');
  for (const seg of encodeChunked(view, seqs[seqs.length - 1]! + 1, todo)) {
    await appendSegment(deps, repo, git.teamId, git.agentId, seg.seq, seg.data);
  }
  const ownHead = await localAgentHead(deps, repo, git.teamId, git.agentId);
  const r = await ingestAgent(deps, repo, view, git.agentId, ownHead!);
  summary.problems.push(...r.problems);
  summary.ingested += r.ops.length;
  const published = new Set(r.ops.map((o) => o.id));
  await files.removePending(todo.map((o) => o.id).filter((id) => published.has(id)));
  return todo.length;
}

/** Pushes our log (and the team meta if we created it and the remote lacks it). Returns error strings. */
async function pushAll(deps: Deps, repo: string, view: GitView, status: SyncStatus, now: number, summary: SyncSummary): Promise<void> {
  const { teamId, agentId, remote } = view.git;
  if ((await hasLocalMeta(deps, repo, teamId)) && !(await hasFetchedMeta(deps, repo, teamId))) {
    const m = await pushMeta(deps, repo, remote, teamId);
    if (!m.ok) summary.errors.push(`push meta: ${m.error}`);
  }
  const local = await localAgentHead(deps, repo, teamId, agentId);
  if (!local || local === (await fetchedAgentHead(deps, repo, teamId, agentId))) return;
  const p = await pushOwn(deps, repo, remote, teamId, agentId);
  if (!p.ok) {
    summary.errors.push(`push: ${p.error}`);
    return;
  }
  await setFetchedAgentHead(deps, repo, teamId, agentId, local);
  status.lastPushAt = new Date(now).toISOString();
  summary.pushed = true;
}

// ---- The round -------------------------------------------------------------------------------------

async function runRound(deps: Deps, repo: string, view: GitView, status: SyncStatus, now: () => number, heartbeat: () => Promise<void>, summary: SyncSummary): Promise<void> {
  const { teamId, remote, agentId } = view.git;
  const f = await fetchTeam(deps, repo, remote, teamId);
  await heartbeat();
  if (f.ok) {
    status.lastFetchAt = new Date(now()).toISOString();
    summary.fetched = true;
    await reseedOwnLog(deps, repo, view);
  } else {
    summary.errors.push(`fetch: ${f.error}`);
  }
  await applyIngested(view, await ingestAll(deps, repo, view, summary), now, summary);
  await applyPresence(deps, repo, view, now());
  for (let pass = 0; pass < MAX_PUBLISH_PASSES; pass++) {
    const published = await publishPending(deps, repo, view, summary);
    summary.published += published;
    const due = !status.lastPresenceAt || now() - Date.parse(status.lastPresenceAt) >= PRESENCE_INTERVAL_MS;
    if (due && (await localAgentHead(deps, repo, teamId, agentId))) {
      await setPresence(deps, repo, teamId, agentId, encodePresence(view, now()));
      status.lastPresenceAt = new Date(now()).toISOString();
    }
    await pushAll(deps, repo, view, status, now(), summary);
    await heartbeat();
    if (summary.errors.some((e) => e.startsWith('push')) || (await view.files.listPending()).length === 0) break;
  }
}

/**
 * Runs one round. Never throws for network or remote problems: they are returned in the summary, written to
 * sync.log and recorded in sync-status.json (lastError), and pending ops stay queued for the next round.
 */
export async function syncRound(deps: Deps, repo: string, cred: Credential, opts: SyncOptions = {}): Promise<SyncSummary> {
  const now = opts.now ?? Date.now;
  const view = await openGitView(deps, { ...cred, repoPath: repo });
  const summary = emptySummary();
  const lock = await acquireLock(view.paths.lock, { waitMs: opts.waitMs ?? 0, now });
  if (!lock) return { ...summary, ok: false, skipped: 'locked' };
  const status: SyncStatus = { ...(await readStatus(view.paths)), lastAttemptAt: new Date(now()).toISOString() };
  try {
    await writeStatus(view.paths, status);
    await runRound(deps, repo, view, status, now, () => lock.heartbeat(), summary);
  } catch (err) {
    summary.errors.push(message(err));
  } finally {
    for (const p of summary.problems) await logSyncError(view.paths, `refused: ${p}`, now()).catch(() => undefined);
    for (const e of summary.errors) await logSyncError(view.paths, e, now()).catch(() => undefined);
    summary.ok = summary.errors.length === 0;
    const next: SyncStatus = summary.ok
      ? { ...status, lastError: null }
      : { ...status, lastError: summary.errors[0]!.split('\n')[0]!, lastErrorAt: new Date(now()).toISOString() };
    await writeStatus(view.paths, next).catch(() => undefined);
    await lock.release();
  }
  return summary;
}

/**
 * Writes this agent's seq-0 bootstrap segment (a createTeam or join op from captureBootstrapOp, alone) to its
 * local log and applies it to the view, under the sync lock. The next round pushes it. For create/join (Task 8).
 */
export async function writeBootstrap(deps: Deps, repo: string, cred: Credential, op: Op, opts: SyncOptions = {}): Promise<SyncSummary> {
  const now = opts.now ?? Date.now;
  const view = await openGitView(deps, { ...cred, repoPath: repo });
  const { teamId, agentId, teamKey, privateKey, publicKey } = view.git;
  if (op.agent !== agentId || (op.input as { publicKey?: unknown } | null)?.publicKey !== publicKey) {
    throw new Error('bootstrap op does not belong to this credential');
  }
  const lock = await acquireLock(view.paths.lock, { waitMs: opts.waitMs ?? 30_000, now });
  if (!lock) throw new Error('another sync is running; try again');
  const summary = emptySummary();
  try {
    if (await localAgentHead(deps, repo, teamId, agentId)) throw new Error('this agent already has a log');
    await appendSegment(deps, repo, teamId, agentId, 0, encodeSegment({ teamId, agent: agentId, seq: 0, ops: [op] }, teamKey, privateKey));
    const r = await ingestAgent(deps, repo, view, agentId, (await localAgentHead(deps, repo, teamId, agentId))!);
    if (r.problems.length > 0) throw new Error(r.problems.join('; '));
    summary.ingested = r.ops.length;
    await applyIngested(view, r.ops, now, summary);
  } finally {
    await lock.release();
  }
  return summary;
}

/** One-line human summary for `agentteams sync`. */
export function formatSyncSummary(s: SyncSummary): string {
  if (s.skipped) return 'agentteams: another sync is running; skipped';
  const parts = [
    s.fetched ? 'fetched' : 'fetch failed',
    `${s.ingested} op${s.ingested === 1 ? '' : 's'} received`,
    `${s.published} sent`,
    s.pushed ? 'pushed' : null,
    s.rebuilt ? 'view rebuilt' : null,
    s.problems.length ? `${s.problems.length} refused (see .git/agentteams/sync.log)` : null,
  ].filter(Boolean);
  const head = s.ok ? 'synced' : `sync failed: ${s.errors[0]}`;
  return `agentteams: ${head} (${parts.join(', ')})`;
}
