/**
 * Our own log on the remote, checked every round by path and content (never by commit history).
 *
 * The remote tip's tree is compared with our local log tree, shard by shard (identical subtrees are skipped by id):
 *   - same root tree: in sync, nothing to do;
 *   - remote segments we lack, contiguous after our last one, each verifying under OUR key: ours (a re-clone, or a
 *     crash after a push): adopted into the local log, at any depth;
 *   - a remote presence that verifies under our key and is newer than ours: adopted, so our next one is newer still;
 *   - anything else that differs (junk, extra files, missing or replaced segments that do not verify, an oversized
 *     or unreadable tree): vandalism; the push phase restores our log over it (leased on the observed tip);
 *   - a segment that differs from ours yet verifies under our key: this credential wrote it from another clone. We
 *     never push over it; the round fails with an error until a person resolves it.
 * Pushing needs only that our local tree verifies (every seq 0..n present, each under our key: ingest.ts).
 */
import type { CliDeps } from '../deps.js';
import { inspectTip, verifySegment, type TipTree } from './ingest.js';
import { decodePresence, isNewer, type Presence } from './presence.js';
import {
  MAX_PRESENCE_BYTES, MAX_SHARD_TREE_BYTES, SEG_FILE_RE, SEQ_PER_SHARD, SHARD_RE, addToLocalLog, fetchedAgentHead, localAgentHead,
  objectInfo, readBlobs, shardOf, treeEntries, treeOf,
} from './refs.js';
import { MAX_SEGMENT_BYTES } from './segment.js';
import type { SyncLock } from './syncState.js';
import type { GitView } from './view.js';

type Deps = Pick<CliDeps, 'exec'>;
type Entries = Map<string, { oid: string; type: string }>;

export interface OwnRemote {
  /** The remote tip we observed: the lease of our next push (null: no remote log yet). */
  observed: string | null;
  /** Root tree of the remote log when known; equal to our local root means nothing to push. */
  remoteRoot: string | null;
  /** The remote held data that is not ours: the next push is a restore. */
  vandalised: boolean;
  /** The remote holds a different segment signed with our key (another clone of this credential): never pushed over. */
  conflict: string | null;
}

interface Comparison {
  vandalised: boolean;
  conflict: string | null;
  adopt: Array<{ seq: number; blob: string }>;
  presence: string | null;
}

const EMPTY: Entries = new Map();

async function entriesOf(deps: Deps, repo: string, tree: string | undefined): Promise<Entries> {
  return tree ? treeEntries(deps, repo, tree) : EMPTY;
}

/** Our local log's shards (trusted: written by this OS user): shard -> entries, plus the next seq. */
async function localShards(deps: Deps, repo: string, localRoot: string | null): Promise<{ shards: Entries; next: number }> {
  const root = localRoot ? await treeEntries(deps, repo, localRoot) : EMPTY;
  const shards = await entriesOf(deps, repo, root.get('ops')?.oid);
  const last = [...shards.keys()].filter((s) => SHARD_RE.test(s)).sort().pop();
  if (!last) return { shards, next: 0 };
  const seqs = [...(await treeEntries(deps, repo, shards.get(last)!.oid)).keys()]
    .map((n) => SEG_FILE_RE.exec(n)?.[1]).filter((x): x is string => Boolean(x)).map(Number);
  return { shards, next: seqs.length ? Math.max(...seqs) + 1 : 0 };
}

/** Verifies remote blobs (size-checked first) as our segments; returns how many verified, in order. */
async function verifiedPrefix(deps: Deps, repo: string, view: GitView, items: Array<{ seq: number; blob: string }>): Promise<number> {
  const infos = await objectInfo(deps, repo, items.map((i) => i.blob));
  let ok = 0;
  for (; ok < items.length; ok++) {
    const info = infos[ok];
    if (!info || info.type !== 'blob' || info.size > MAX_SEGMENT_BYTES) break;
  }
  const blobs = await readBlobs(deps, repo, items.slice(0, ok).map((i) => i.blob));
  for (let i = 0; i < ok; i++) {
    const v = await verifySegment(view, view.git.agentId, view.git.publicKey, items[i]!.seq, blobs[i]!);
    if (typeof v === 'string') return i;
  }
  return ok;
}

async function readOwnPresence(deps: Deps, repo: string, view: GitView, blob: string | undefined): Promise<Presence | null> {
  if (!blob) return null;
  const [info] = await objectInfo(deps, repo, [blob]);
  if (!info || info.type !== 'blob' || info.size > MAX_PRESENCE_BYTES) return null;
  const [buf] = await readBlobs(deps, repo, [blob]);
  const { teamKey, teamId, agentId, publicKey } = view.git;
  return decodePresence(buf!, teamKey, teamId, agentId, publicKey);
}

/** Compares the (guarded) remote tree with our local one. Remote shards are size-checked before they are listed. */
async function compare(deps: Deps, repo: string, view: GitView, t: TipTree, localRoot: string | null): Promise<Comparison> {
  const out: Comparison = { vandalised: false, conflict: null, adopt: [], presence: null };
  const remoteRoot = await treeEntries(deps, repo, t.root);
  if ([...remoteRoot.keys()].some((n) => n !== 'ops' && n !== 'presence.bin')) out.vandalised = true;
  const local = await localShards(deps, repo, localRoot);
  const remoteShards = await entriesOf(deps, repo, t.ops ?? undefined);
  const extras: Array<{ seq: number; blob: string }> = [];
  const differs: Array<{ seq: number; blob: string }> = [];
  let remoteMax = -1;
  const missing: number[] = [];
  // Honest shards are contiguous from 00000; the first one that is not (or any junk) ends the comparison, so a
  // flood of shard entries costs one tree listing, not one git call each.
  const names = [...remoteShards.keys()].sort();
  for (let i = 0; i < names.length && !out.vandalised; i++) {
    const shard = names[i]!;
    const e = remoteShards.get(shard)!;
    if (!SHARD_RE.test(shard) || Number(shard) !== i || e.type !== 'tree') { out.vandalised = true; break; }
    const mine = local.shards.get(shard);
    if (mine?.oid === e.oid) { remoteMax = Math.max(remoteMax, (i + 1) * SEQ_PER_SHARD - 1); continue; }
    const [info] = await objectInfo(deps, repo, [e.oid]);
    if (!info || info.size > MAX_SHARD_TREE_BYTES) { out.vandalised = true; break; }
    const theirs = await treeEntries(deps, repo, e.oid);
    const ours = await entriesOf(deps, repo, mine?.oid);
    for (const [name, f] of theirs) {
      const m = SEG_FILE_RE.exec(name);
      if (!m || f.type !== 'blob' || shardOf(Number(m[1])) !== shard) { out.vandalised = true; continue; }
      const seq = Number(m[1]);
      remoteMax = Math.max(remoteMax, seq);
      const o = ours.get(name);
      if (!o) extras.push({ seq, blob: f.oid });
      else if (o.oid !== f.oid) differs.push({ seq, blob: f.oid });
    }
    for (const name of ours.keys()) if (!theirs.has(name)) missing.push(Number(SEG_FILE_RE.exec(name)?.[1] ?? -1));
  }
  for (const [shard] of local.shards) if (!remoteShards.has(shard)) missing.push(Number(shard) * SEQ_PER_SHARD);
  // A missing seq below one the remote has: truncated in the middle.
  if (missing.some((s) => s >= 0 && s < remoteMax)) out.vandalised = true;
  for (const d of differs.sort((a, b) => a.seq - b.seq)) {
    if ((await verifiedPrefix(deps, repo, view, [d])) === 1) { out.conflict = `seq ${d.seq}`; return out; }
    out.vandalised = true;
  }
  // Ours if contiguous after our last segment and verified under our key; the rest is vandalism.
  extras.sort((a, b) => a.seq - b.seq);
  let run = 0;
  while (run < extras.length && extras[run]!.seq === local.next + run) run++;
  const good = await verifiedPrefix(deps, repo, view, extras.slice(0, run));
  out.adopt = extras.slice(0, good);
  if (good < extras.length) out.vandalised = true;
  // Presence: theirs must verify under our key; a newer one is adopted.
  const theirsP = remoteRoot.get('presence.bin');
  const oursP = localRoot ? (await treeEntries(deps, repo, localRoot)).get('presence.bin') : undefined;
  if (theirsP && theirsP.oid !== oursP?.oid) {
    const p = await readOwnPresence(deps, repo, view, theirsP.type === 'blob' ? theirsP.oid : undefined);
    if (!p) out.vandalised = true;
    else if (isNewer(p, (await readOwnPresence(deps, repo, view, oursP?.oid)) ?? undefined)) out.presence = theirsP.oid;
  }
  return out;
}

/**
 * Checks our remote log against our local one, adopting our own remote segments and presence (see the header).
 * Never throws except a lost lock or a moved ref; problems and the conflict error go into `report`.
 */
export async function checkOwnRemote(
  deps: Deps, repo: string, view: GitView, lock: SyncLock, report: { problems: string[]; errors: string[] },
): Promise<OwnRemote> {
  const { teamId, agentId } = view.git;
  const observed = await fetchedAgentHead(deps, repo, teamId, agentId);
  const base: OwnRemote = { observed, remoteRoot: null, vandalised: false, conflict: null };
  if (!observed) return base;
  try {
    const t = await inspectTip(deps, repo, observed);
    if (typeof t === 'string') {
      report.problems.push(`our own log on the remote is not usable (${t}); restoring it`);
      return { ...base, vandalised: true };
    }
    const local = await localAgentHead(deps, repo, teamId, agentId);
    const localRoot = local ? await treeOf(deps, repo, local) : null;
    if (localRoot === t.root) return { ...base, remoteRoot: t.root };
    const c = await compare(deps, repo, view, t, localRoot);
    if (c.conflict) {
      report.errors.push(`our log on the remote has a different ${c.conflict} signed with this agent's key (is this credential in use in another clone?); not pushing`);
      return { ...base, remoteRoot: t.root, conflict: c.conflict };
    }
    if (c.adopt.length > 0 || c.presence) {
      await lock.assertOwned();
      await addToLocalLog(deps, repo, teamId, agentId, c.adopt, c.presence, local);
    }
    if (c.vandalised) report.problems.push('our own log on the remote was altered (it holds data that is not ours); restoring it');
    return { ...base, remoteRoot: t.root, vandalised: c.vandalised };
  } catch (err) {
    if (err instanceof Error && (err.name === 'LostLockError' || err.name === 'RefMovedError')) throw err;
    const m = err instanceof Error ? err.message : String(err);
    report.problems.push(`our own log on the remote could not be checked (${m.replace(/\s+/g, ' ').slice(0, 160)}); restoring it`);
    return { ...base, vandalised: true };
  }
}
