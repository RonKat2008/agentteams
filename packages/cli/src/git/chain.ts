/**
 * Verifying an agent's log chain (`refs/agentteams/<team>/agents/<agent>`), bounded and commit by commit.
 *
 * The recorded head of an agent advances ONLY through commits that are provably that agent's own:
 *   - a commit that adds exactly the next `ops/<seq>.bin`, which decodes and verifies under the agent's pinned
 *     key (seq 0: the TOFU bootstrap, whose key is then pinned forever); or
 *   - a commit that changes only `presence.bin`, which decodes and verifies as that agent's presence and is
 *     strictly newer than the last accepted presence (a replayed old blob is refused).
 * Anything else (an empty commit, junk, extra files, a gap, an oversized diff or blob) stops the walk; the head
 * stays at the last good commit, so a later restore of the real chain (a fast-forward from it) is accepted.
 * Every git call is bounded: `rev-list --count`, then at most `maxCommits` commit ids, per-commit diffs with a
 * byte cap, blob sizes before blob reads.
 */
import type { CliDeps } from '../deps.js';
import { decrypt, encrypt, sign, verify } from './crypto.js';
import type { Op } from './ops.js';
import {
  commitChanges, countCommits, type CommitChanges, isAncestor, oldestCommits, readBlobs, readPresenceBlob, setSeenAgentHead, sizesOf,
} from './refs.js';
import type { AcceptedSegment } from './replicaStore.js';
import { getPinnedKey, pinAgentKey } from './replay.js';
import { MAX_SEGMENT_BYTES, decodeSegment } from './segment.js';
import type { SyncLock } from './syncState.js';
import type { GitView } from './view.js';

type Deps = Pick<CliDeps, 'exec'>;

/** Commits whose diffs are fetched in one `diff-tree --stdin` call. */
const DIFF_BATCH = 64;
const OPS_FILE_RE = /^ops\/(\d{8})\.bin$/;
export const short = (sha: string): string => sha.slice(0, 12);

// ---- Presence (encrypted under the team key, signed by the agent, bound to team and agent) -----------

const PRESENCE_TAG = 'agentteams-presence-v1';
const presenceContext = (teamId: string, agent: string) => Buffer.from(`${PRESENCE_TAG}\0${teamId}\0${agent}\0`, 'utf8');

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

// ---- The walk ----------------------------------------------------------------------------------------

export interface WalkOpts {
  agent: string;
  /** Last accepted commit (exclusive start); undefined = from the root. */
  from: string | undefined;
  tip: string;
  nextSeq: number;
  /** Last accepted presence time (ms); later presence must be strictly newer. */
  presenceMs: number;
  maxSegments: number;
  maxCommits: number;
  /** For our own log: every segment and presence must verify under this key (seq 0's bootstrap key included). */
  requireKey?: string;
}

export interface WalkResult {
  accepted: AcceptedSegment[];
  /** The last good commit walked (undefined: none). */
  head: string | undefined;
  nextSeq: number;
  presenceMs: number;
  /** Refusals (security): the walk stopped at the first one. */
  problems: string[];
  /** Stopped at a cap (more next round), not because of bad data. */
  capped: boolean;
  /** Every commit up to the tip was accepted. */
  complete: boolean;
}

type Step = { ok: true; ops?: Op[]; presenceMs?: number } | { ok: false; why: string } | { cap: true };

export async function walkChain(deps: Deps, repo: string, view: GitView, o: WalkOpts): Promise<WalkResult> {
  const total = await countCommits(deps, repo, o.from ?? null, o.tip);
  const take = Math.min(total, o.maxCommits);
  const shas = await oldestCommits(deps, repo, o.from ?? null, o.tip, total, take);
  const r: WalkResult = {
    accepted: [], head: undefined, nextSeq: o.nextSeq, presenceMs: o.presenceMs, problems: [], capped: total > take, complete: false,
  };
  let stopped = false;
  for (let i = 0; i < shas.length && !stopped; i += DIFF_BATCH) {
    const chunk = shas.slice(i, i + DIFF_BATCH);
    const changes = await commitChanges(deps, repo, chunk);
    for (const sha of chunk) {
      const step = await stepCommit(deps, repo, view, o, r, sha, changes.get(sha) ?? []);
      if ('cap' in step) { r.capped = true; stopped = true; break; }
      if (!step.ok) { r.problems.push(`agent ${o.agent}: commit ${short(sha)}: ${step.why}; refused`); stopped = true; break; }
      if (step.ops) { r.accepted.push({ seq: r.nextSeq, ops: step.ops }); r.nextSeq++; }
      if (step.presenceMs !== undefined) r.presenceMs = step.presenceMs;
      r.head = sha;
    }
  }
  r.complete = !stopped && !r.capped && r.problems.length === 0;
  return r;
}

async function stepCommit(
  deps: Deps, repo: string, view: GitView, o: WalkOpts, r: WalkResult, sha: string, ch: CommitChanges,
): Promise<Step> {
  if (ch === 'too-large') return { ok: false, why: 'changes too many files' };
  if (ch.length === 0) return { ok: false, why: 'changes nothing' };
  if (ch.length > 1) return { ok: false, why: `changes ${ch.length} files` };
  const c = ch[0]!;
  if (c.path === 'presence.bin' && (c.status === 'A' || c.status === 'M')) {
    const key = o.requireKey ?? (await getPinnedKey(view.store, o.agent));
    if (!key) return { ok: false, why: 'presence before the agent\'s key is known' };
    const blob = await readPresenceBlob(deps, repo, c.blob);
    const at = blob ? decodePresence(blob, view.git.teamKey, view.git.teamId, o.agent, key) : null;
    if (at === null) return { ok: false, why: 'presence does not verify' };
    if (at <= r.presenceMs) return { ok: false, why: 'presence is not newer than the last one (replayed?)' };
    return { ok: true, presenceMs: at };
  }
  const m = OPS_FILE_RE.exec(c.path);
  if (!m || c.status !== 'A') return { ok: false, why: `${c.status === 'A' ? 'adds' : 'changes'} ${c.path.slice(0, 80)}` };
  const seq = Number(m[1]);
  if (seq !== r.nextSeq) return { ok: false, why: `adds seq ${seq} where seq ${r.nextSeq} was expected (gap or rewrite)` };
  if (r.accepted.length >= o.maxSegments) return { cap: true };
  const [size] = await sizesOf(deps, repo, [c.blob]);
  if (size === undefined || size > MAX_SEGMENT_BYTES) return { ok: false, why: `seq ${seq} is ${size} bytes, over the segment limit` };
  const [data] = await readBlobs(deps, repo, [c.blob]);
  const v = await verifySegment(view, o, seq, data!);
  return typeof v === 'string' ? { ok: false, why: `seq ${seq} ${v}` } : { ok: true, ops: v };
}

/** The segment's ops when it verifies (pinning the key at seq 0), else the refusal reason. */
async function verifySegment(view: GitView, o: WalkOpts, seq: number, data: Buffer): Promise<Op[] | string> {
  const { git, store } = view;
  const pinned = seq === 0 ? undefined : (o.requireKey ?? (await getPinnedKey(store, o.agent)));
  if (seq > 0 && pinned === undefined) return 'has no pinned key for this agent';
  const d = decodeSegment(data, git.teamKey, { teamId: git.teamId, agent: o.agent, seq }, (id) => (id === o.agent ? pinned : undefined));
  if (!d.ok) return `does not verify (${d.reason})`;
  if (seq === 0) {
    if (!d.bootstrapKey) return 'is not a bootstrap segment';
    if (o.requireKey !== undefined && d.bootstrapKey !== o.requireKey) return 'bootstrap key is not ours';
    if ((await pinAgentKey(store, o.agent, d.bootstrapKey)) === 'mismatch') return 'bootstrap key differs from the pinned key';
  }
  return d.segment.ops;
}

// ---- Ingestion of one agent ----------------------------------------------------------------------------

/** Remote agents: at most this many segments and commits per round (a backlog drains over several rounds). */
export const MAX_SEGMENTS_PER_AGENT = 32;
export const MAX_COMMITS_PER_AGENT = 512;
/** Logs written in this clone: the same rules, larger caps. */
const LOCAL_MAX_COMMITS = 10_000;

/**
 * Verifies and stores an agent's new commits up to `tip`. `local`: the log was written in this clone (see the
 * trust boundary note in sync.ts). Refusals are returned, never thrown; git failures throw (the caller isolates them).
 */
export async function ingestAgent(
  deps: Deps, repo: string, view: GitView, lock: SyncLock | null, agent: string, tip: string, local: boolean,
): Promise<{ ops: Op[]; problems: string[] }> {
  const { files } = view;
  const prev = (await files.readLogState()).agents[agent] ?? { nextSeq: 0 };
  if (prev.head === tip) return { ops: [], problems: [] };
  if (prev.head && !(await isAncestor(deps, repo, prev.head, tip))) {
    return { ops: [], problems: [`agent ${agent}: non-fast-forward rewrite (${short(prev.head)} -> ${short(tip)}) refused; keeping the accepted chain`] };
  }
  const own = agent === view.git.agentId;
  const r = await walkChain(deps, repo, view, {
    agent, from: prev.head, tip, nextSeq: prev.nextSeq, presenceMs: prev.presenceMs ?? 0,
    maxSegments: local ? Number.MAX_SAFE_INTEGER : MAX_SEGMENTS_PER_AGENT,
    maxCommits: local ? LOCAL_MAX_COMMITS : MAX_COMMITS_PER_AGENT,
    ...(own ? { requireKey: view.git.publicKey } : {}),
  });
  if (r.head && r.head !== prev.head) {
    await lock?.assertOwned();
    // Crash order: ops first, then the keep-alive ref, then the state that points past them (CAS on the old head).
    await files.appendAccepted(agent, r.accepted);
    await setSeenAgentHead(deps, repo, view.git.teamId, agent, r.head);
    await files.setAgentState(agent, { head: r.head, nextSeq: r.nextSeq, presenceMs: r.presenceMs }, prev.head);
  }
  return { ops: r.accepted.flatMap((s) => s.ops), problems: r.problems };
}
