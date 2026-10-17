/**
 * Path-based ingestion of agents' logs (`refs/agentteams/<team>/agents/<agent>`).
 *
 * A replica never follows commits. For each agent it takes the tip's tree and reads `ops/<shard>/<seq>.bin` for
 * seq = nextSeq, nextSeq + 1, ... until a path is missing or the round's budget runs out. Each blob is size-checked
 * (<= MAX_SEGMENT_BYTES) before it is read, then decoded and verified: the signature binds team, agent and seq, and
 * the key is the agent's pin (seq 0: its bootstrap key, pinned on first sight). Commit ids, parents and history are
 * ignored, so re-created or rewritten commits cannot fork a replica.
 *
 *   - Accepted: per agent `nextSeq`, the blob id (content hash) of each accepted seq, and the last presence.
 *   - Refused: a blob that does not verify stops that agent at that seq for this tip, with one warning; any later
 *     tip is read again, so a valid blob at the same path is accepted.
 *   - Equivocation: when a tip changes, the last accepted seq is looked up again and compared by its decrypted, signed
 *     content (segmentContentHash), never by blob id: a re-encrypted copy is the same segment and is ignored
 *     silently. Different signed content is equivocation; content that does not verify is vandalism. Both are
 *     logged and ignored; the accepted copy stays.
 *   - Size guards before any lookup: the tip commit, the root tree (<= 4 KiB: `ops` and `presence.bin`), the `ops`
 *     tree (<= 4 MiB) and each shard tree (<= 64 KiB). An oversized log is skipped with a warning.
 *   - Budget: remote agents share a per-round budget of segments and of agent visits (each visit reads at most one
 *     presence), handed out round-robin. The start offset advances by the number of agents served each round, so
 *     with B agents holding backlogs every one is served within about B / 8 rounds (B / 64 for visits). Logs of
 *     this clone are not budgeted. Leftover work is reported as `morePending` and continues next round.
 *   - A tip fully processed is cached (`doneTip`), so an unchanged agent costs nothing.
 */
import type { CliDeps } from '../deps.js';
import type { Op } from './ops.js';
import { decodePresence, isNewer } from './presence.js';
import {
  MAX_COMMIT_BYTES, MAX_OPS_TREE_BYTES, MAX_PRESENCE_BYTES, MAX_ROOT_TREE_BYTES, MAX_SHARD_TREE_BYTES, objectInfo, readSizedBlobs, segFile,
  shardOf, type ObjInfo,
} from './refs.js';
import type { AcceptedSegment, AgentLogState } from './replicaStore.js';
import { getPinnedKey, pinAgentKey } from './replay.js';
import { MAX_SEGMENT_BYTES, decodeSegment, segmentContentHash } from './segment.js';
import type { SyncLock } from './syncState.js';
import type { GitView } from './view.js';

type Deps = Pick<CliDeps, 'exec'>;

/** Per round, across all remote agents: new segments read, and agents visited (each reads at most one presence). */
export const SEGMENT_BUDGET = 64;
export const PRESENCE_BUDGET = 64;
/** Segments per agent per round-robin pass. */
const QUANTUM = 8;
/** Logs of this clone: segments per lookup batch (unbudgeted). */
const LOCAL_BATCH = 256;

export interface Budget { segments: number; presence: number }
export interface IngestTarget { agent: string; tip: string; local: boolean }
export interface IngestResult { ops: Op[]; problems: string[]; morePending: boolean }

export const short = (sha: string): string => sha.slice(0, 12);
const isFatal = (err: unknown) => err instanceof Error && (err.name === 'LostLockError' || err.name === 'RefMovedError');

// ---- Tip inspection (size guards) ---------------------------------------------------------------------

export interface TipTree { root: string; ops: string | null; presence: ObjInfo | null }

/** The tip's root, ops tree and presence entry once every guard passed, else why not. Bounded: 3 git calls. */
export async function inspectTip(deps: Deps, repo: string, tip: string): Promise<TipTree | string> {
  const [c] = await objectInfo(deps, repo, [tip]);
  if (!c) return 'the tip is missing';
  if (c.type !== 'commit') return `the tip is a ${c.type}, not a commit`;
  if (c.size > MAX_COMMIT_BYTES) return `the tip commit is ${c.size} bytes (limit ${MAX_COMMIT_BYTES})`;
  const [r] = await objectInfo(deps, repo, [`${tip}^{tree}`]);
  if (!r || r.type !== 'tree') return 'the tip has no tree';
  if (r.size > MAX_ROOT_TREE_BYTES) return `the log tree is oversized (root ${r.size} bytes, limit ${MAX_ROOT_TREE_BYTES})`;
  const [o, p] = await objectInfo(deps, repo, [`${r.oid}:ops`, `${r.oid}:presence.bin`]);
  if (o && o.type !== 'tree') return 'ops is not a directory';
  if (o && o.size > MAX_OPS_TREE_BYTES) return `the log tree is oversized (ops ${o.size} bytes, limit ${MAX_OPS_TREE_BYTES})`;
  return { root: r.oid, ops: o?.oid ?? null, presence: p ?? null };
}

/** A shard tree of a guarded tip: its id, null when absent, or why it is refused. Cached per tip. */
async function shardTree(deps: Deps, repo: string, t: TipTree, cache: Map<string, string | null>, shard: string): Promise<string | null> {
  if (!t.ops) return null;
  const cached = cache.get(shard);
  if (cached !== undefined) return cached;
  const [s] = await objectInfo(deps, repo, [`${t.ops}:${shard}`]);
  if (s && s.type !== 'tree') throw new Refusal(`ops/${shard} is not a directory`);
  if (s && s.size > MAX_SHARD_TREE_BYTES) throw new Refusal(`ops/${shard} is oversized (${s.size} bytes, limit ${MAX_SHARD_TREE_BYTES})`);
  cache.set(shard, s?.oid ?? null);
  return s?.oid ?? null;
}

class Refusal extends Error {}

/**
 * Blob entries for seqs from..from+n-1, in order, up to (not including) the first missing one. Throws Refusal for a
 * guard failure. `end`: a path was missing (nothing more at this tip).
 */
export async function lookupSeqs(
  deps: Deps, repo: string, t: TipTree, cache: Map<string, string | null>, from: number, n: number,
): Promise<{ found: Array<{ seq: number; info: ObjInfo }>; end: boolean }> {
  const found: Array<{ seq: number; info: ObjInfo }> = [];
  let seq = from;
  while (seq < from + n) {
    const shard = shardOf(seq);
    const tree = await shardTree(deps, repo, t, cache, shard);
    if (!tree) return { found, end: true };
    const seqs: number[] = [];
    for (; seq < from + n && shardOf(seq) === shard; seq++) seqs.push(seq);
    const infos = await objectInfo(deps, repo, seqs.map((s) => `${tree}:${segFile(s)}`));
    for (let i = 0; i < seqs.length; i++) {
      const info = infos[i];
      if (!info) return { found, end: true };
      found.push({ seq: seqs[i]!, info });
    }
  }
  return { found, end: false };
}

// ---- Verification -------------------------------------------------------------------------------------

/** The segment's ops when it verifies (pinning the key at seq 0), else the refusal reason. */
export async function verifySegment(view: GitView, agent: string, requireKey: string | undefined, seq: number, data: Buffer): Promise<Op[] | string> {
  const { git, store } = view;
  const pinned = seq === 0 ? undefined : (requireKey ?? (await getPinnedKey(store, agent)));
  if (seq > 0 && pinned === undefined) return 'has no pinned key for this agent';
  const d = decodeSegment(data, git.teamKey, { teamId: git.teamId, agent, seq }, (id) => (id === agent ? pinned : undefined));
  if (!d.ok) return `does not verify (${d.reason})`;
  if (seq === 0) {
    if (!d.bootstrapKey) return 'is not a bootstrap segment';
    if (requireKey !== undefined && d.bootstrapKey !== requireKey) return 'bootstrap key is not ours';
    if ((await pinAgentKey(store, agent, d.bootstrapKey)) === 'mismatch') return 'bootstrap key differs from the pinned key';
  }
  return d.segment.ops;
}

// ---- One agent ----------------------------------------------------------------------------------------

interface Cursor {
  target: IngestTarget;
  /** Our own log: every segment and presence must verify under our key. */
  requireKey?: string;
  prev: AgentLogState | null;
  next: AgentLogState;
  tree?: TipTree;
  shards: Map<string, string | null>;
  accepted: AcceptedSegment[];
  segDone: boolean;
  presenceDone: boolean;
  stuck: boolean;
  /** A git failure (not refused data): retried next round. */
  failed: boolean;
  /** Received segment reads this round (for the rotation). */
  served: boolean;
}

function newCursor(view: GitView, target: IngestTarget, prev: AgentLogState | null): Cursor {
  const { doneTip: _d, stuck: _s, gone: _g, ...rest } = prev ?? { nextSeq: 0 };
  return {
    target, prev, next: { ...rest }, shards: new Map(), accepted: [], segDone: false, presenceDone: false, stuck: false, failed: false, served: false,
    ...(target.agent === view.git.agentId ? { requireKey: view.git.publicKey } : {}),
  };
}

/** Guards the tip, then re-checks the last accepted seq (equivocation). */
async function openCursor(deps: Deps, repo: string, view: GitView, c: Cursor, problems: string[]): Promise<void> {
  const { agent, tip } = c.target;
  const t = await inspectTip(deps, repo, tip);
  if (typeof t === 'string') {
    problems.push(`agent ${agent}: ${t}; skipped until its log changes`);
    c.segDone = c.presenceDone = c.stuck = true;
    return;
  }
  c.tree = t;
  const last = c.next.nextSeq - 1;
  if (last < 0 || !c.next.lastBlob) return;
  const { found } = await lookupSeqs(deps, repo, t, c.shards, last, 1);
  const info = found[0]?.info;
  if (!info) {
    problems.push(`agent ${agent}: its log no longer has seq ${last} (rolled back or vandalised); keeping the accepted copy`);
    return;
  }
  if (info.oid === c.next.lastBlob) return;
  const data = info.type === 'blob' && info.size <= MAX_SEGMENT_BYTES ? (await readSizedBlobs(deps, repo, [info]))[0]! : null;
  const { teamKey, teamId } = view.git;
  const hash = data ? segmentContentHash(data, teamKey, { teamId, agent, seq: last }) : null;
  if (hash !== null && hash === c.next.lastHash) return; // a re-encrypted copy of the accepted segment: the same
  const signed = data !== null && typeof (await verifySegment(view, agent, c.requireKey, last, data)) !== 'string';
  problems.push(signed
    ? `agent ${agent}: equivocation: seq ${last} exists with different content signed by this agent; keeping the first copy`
    : `agent ${agent}: seq ${last} was replaced with data that does not verify; ignored`);
}

/** Reads, verifies and accepts up to `n` segments. Returns how many were read (accepted or refused). */
async function readSegments(deps: Deps, repo: string, view: GitView, c: Cursor, n: number, problems: string[]): Promise<number> {
  const { agent } = c.target;
  const before = c.accepted.length;
  const { found, end } = await lookupSeqs(deps, repo, c.tree!, c.shards, c.next.nextSeq, n);
  const ok: Array<{ seq: number; info: ObjInfo }> = [];
  let refused: string | null = null;
  for (const f of found) {
    if (f.info.type !== 'blob') { refused = `seq ${f.seq} is not a file`; break; }
    if (f.info.size > MAX_SEGMENT_BYTES) { refused = `seq ${f.seq} is ${f.info.size} bytes, over the segment limit`; break; }
    ok.push(f);
  }
  const blobs = await readSizedBlobs(deps, repo, ok.map((f) => f.info));
  const { teamKey, teamId } = view.git;
  for (let i = 0; i < ok.length && !refused; i++) {
    const { seq, info } = ok[i]!;
    const v = await verifySegment(view, agent, c.requireKey, seq, blobs[i]!);
    if (typeof v === 'string') { refused = `seq ${seq} ${v}`; break; }
    const hash = segmentContentHash(blobs[i]!, teamKey, { teamId, agent, seq })!;
    c.accepted.push({ seq, blob: info.oid, hash, ops: v });
    c.next = { ...c.next, nextSeq: seq + 1, lastBlob: info.oid, lastHash: hash };
  }
  if (refused) {
    problems.push(`agent ${agent}: ${refused}; refused`);
    c.segDone = c.stuck = true;
  } else if (end) {
    c.segDone = true;
  }
  return c.accepted.length - before + (refused ? 1 : 0);
}

async function readPresence(deps: Deps, repo: string, view: GitView, c: Cursor, problems: string[]): Promise<void> {
  const { agent } = c.target;
  const p = c.tree?.presence;
  if (!p || p.oid === c.next.presence?.blob) { c.presenceDone = true; return; }
  if (p.type !== 'blob' || p.size > MAX_PRESENCE_BYTES) {
    problems.push(`agent ${agent}: presence.bin is not a small file; ignored`);
    c.presenceDone = true;
    return;
  }
  // Presence counts only for an agent whose bootstrap (seq 0) was accepted: wait for it.
  const key = c.requireKey ?? (c.next.nextSeq > 0 ? await getPinnedKey(view.store, agent) : undefined);
  if (!key) { c.presenceDone = c.segDone; return; }
  const [buf] = await readSizedBlobs(deps, repo, [p]);
  const dec = decodePresence(buf!, view.git.teamKey, view.git.teamId, agent, key);
  if (!dec) problems.push(`agent ${agent}: presence does not verify; ignored`);
  else if (!isNewer(dec, c.next.presence)) problems.push(`agent ${agent}: presence is not newer than the last one (replayed?); ignored`);
  else c.next = { ...c.next, presence: { ...dec, blob: p.oid } };
  c.presenceDone = true;
}

// ---- All agents ---------------------------------------------------------------------------------------

const rotate = <T>(xs: T[], k: number): T[] => (xs.length === 0 ? xs : [...xs.slice(k % xs.length), ...xs.slice(0, k % xs.length)]);

/** Runs `fn` for one agent; a git failure marks it failed (retried next round), never the whole round. */
async function isolated(c: Cursor, problems: string[], fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (isFatal(err)) throw err;
    if (err instanceof Refusal) {
      problems.push(`agent ${c.target.agent}: ${err.message}; skipped until its log changes`);
      c.segDone = c.presenceDone = c.stuck = true;
      return;
    }
    const m = err instanceof Error ? err.message : String(err);
    problems.push(`agent ${c.target.agent}: unreadable log (${m.replace(/\s+/g, ' ').slice(0, 160)}); skipped this round`);
    c.failed = true;
  }
}

/**
 * Ingests every target whose tip was not fully processed yet. `budget` (shared and decremented) bounds remote
 * agents; null = unbounded (our own log after a write). Refusals are returned, never thrown.
 * With `toApply`, the caller applies the returned ops: the `unapplied` marker is set before any of them is recorded
 * (and cleared by the caller after the apply), so a failed apply is redone by a rebuild. Without it the ops are
 * already in the view (our own log after a write).
 */
export async function ingestAgents(
  deps: Deps, repo: string, view: GitView, lock: SyncLock | null, targets: IngestTarget[], budget: Budget | null, toApply = true,
): Promise<IngestResult> {
  const { files } = view;
  const state = await files.readLogState();
  const problems: string[] = [];
  let morePending = false;
  // Rotate the stable (sorted) list of all agents, then skip the ones with nothing new: the offset stays meaningful
  // while agents finish.
  const ordered = rotate(targets, state.rotation ?? 0);
  const todo = ordered.filter((t) => state.agents[t.agent]?.doneTip !== t.tip);
  const cursors: Cursor[] = [];
  for (const target of todo) {
    const bounded = budget !== null && !target.local;
    if (bounded && budget.presence <= 0) { morePending = true; continue; }
    if (bounded) budget.presence--;
    const c = newCursor(view, target, state.agents[target.agent] ?? null);
    cursors.push(c);
    await isolated(c, problems, () => openCursor(deps, repo, view, c, problems));
  }
  // Round-robin passes: each agent gets up to QUANTUM segments per pass while the budget lasts.
  for (;;) {
    let progressed = false;
    for (const c of cursors) {
      if (c.segDone || c.failed) continue;
      const bounded = budget !== null && !c.target.local;
      const n = bounded ? Math.min(QUANTUM, budget.segments) : LOCAL_BATCH;
      if (n <= 0) continue;
      let used = 0;
      c.served = true;
      await isolated(c, problems, async () => { used = await readSegments(deps, repo, view, c, n, problems); });
      if (bounded) budget.segments -= used;
      progressed = true;
    }
    if (!progressed) break;
  }
  for (const c of cursors) {
    if (!c.failed && c.tree) await isolated(c, problems, () => readPresence(deps, repo, view, c, problems));
  }
  const ops: Op[] = [];
  if (toApply && cursors.some((c) => c.accepted.length > 0)) {
    await lock?.assertOwned();
    await files.setUnapplied(true);
  }
  for (const c of cursors) {
    const done = !c.failed && c.segDone && c.presenceDone;
    if (!done && !c.failed) morePending = true;
    const next: AgentLogState = { ...c.next, ...(done ? { doneTip: c.target.tip } : {}), ...(done && c.stuck ? { stuck: true } : {}) };
    if (JSON.stringify(next) === JSON.stringify(c.prev)) continue;
    await lock?.assertOwned();
    // Crash order: ops first, then the state that points past them (a re-append is deduplicated by seq).
    await files.appendAccepted(c.target.agent, c.accepted);
    await files.setAgentState(c.target.agent, next, c.prev);
    ops.push(...c.accepted.flatMap((s) => s.ops));
  }
  if (budget !== null && todo.length > 0) {
    // Advance just past the last agent served this round (the last one visited when segments were not the limit).
    const last = [...cursors].reverse().find((c) => budget.segments > 0 || c.served) ?? cursors[0];
    const advance = last ? ordered.indexOf(last.target) + 1 : 1;
    await lock?.assertOwned();
    await files.setRotation(((state.rotation ?? 0) + Math.max(1, advance)) % Math.max(1, targets.length));
  }
  return { ops, problems, morePending };
}

/**
 * Agents we accepted data from whose ref is gone from the remote (and not written in this clone): warned once each
 * (`gone`), keeping everything accepted. The flag clears when the ref comes back.
 */
export async function noteDeletedRefs(view: GitView, lock: SyncLock | null, present: ReadonlySet<string>): Promise<string[]> {
  const { files } = view;
  const problems: string[] = [];
  for (const [agent, st] of Object.entries((await files.readLogState()).agents)) {
    if (present.has(agent) || st.gone || st.nextSeq === 0) continue;
    problems.push(`agent ${agent}: its ref was deleted on the remote; keeping its accepted log`);
    await lock?.assertOwned();
    await files.setAgentState(agent, { ...st, gone: true }, st);
  }
  return problems;
}
