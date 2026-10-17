/**
 * Our own log on the remote, checked every round by path and content (never by commit history).
 *
 * Only the EXPECTED paths are examined: our seqs 0..n-1, then n, n+1, ... for our own segments to adopt, and
 * presence.bin. Shards whose tree id equals ours are skipped whole; anything else on the remote (extra shards or
 * files) is never listed or scanned, so the cost is O(our segments), whatever an attacker pushes. Segments are
 * compared by their decrypted, signed content (segmentContentHash), never by blob id, because any member can
 * re-encrypt a segment.
 *   - same root tree: in sync;
 *   - remote segments after our last one, contiguous and verifying under OUR key: ours (a re-clone, or another
 *     clone of this credential that wrote first): adopted into the local log, at any depth;
 *   - a remote presence that verifies under our key and is newer than ours: adopted;
 *   - an expected path missing below one that exists, a re-encrypted copy, content that does not verify, junk in
 *     the root, or any difference left unexplained: vandalism; the push restores our log over it (leased);
 *   - different content signed with our key at one of our seqs: this credential signed it in another clone. We
 *     never push over it; the round fails with an error until a person resolves it.
 * A deleted remote ref is simply absent: the leased push ("must not exist") recreates it.
 */
import type { CliDeps } from '../deps.js';
import { inspectTip, lookupSeqs, verifySegment, type TipTree } from './ingest.js';
import { decodePresence, isNewer, type Presence } from './presence.js';
import {
  MAX_PRESENCE_BYTES, MAX_SHARD_TREE_BYTES, SEG_FILE_RE, SHARD_RE, addToLocalLog, fetchedAgentHead, localAgentHead, objectInfo,
  readSizedBlobs, treeEntries, treeOf, type ObjInfo,
} from './refs.js';
import { MAX_SEGMENT_BYTES, segmentContentHash } from './segment.js';
import type { SyncLock } from './syncState.js';
import type { GitView } from './view.js';

type Deps = Pick<CliDeps, 'exec'>;
type Entries = Map<string, { oid: string; type: string }>;

/** Remote seqs examined per adoption batch (the read itself is chunked by bytes). */
const ADOPT_BATCH = 256;

export interface OwnRemote {
  /** The remote tip we observed: the lease of our next push (null: the remote has no log of ours). */
  observed: string | null;
  /** Root tree of the remote log when known; equal to our local root means nothing to push. */
  remoteRoot: string | null;
  /** The remote held data that is not ours (or lost our ref): the next push is a restore. */
  vandalised: boolean;
  /** The remote holds different content signed with our key (another clone of this credential): never pushed over. */
  conflict: string | null;
}

interface Comparison {
  vandalised: boolean;
  conflict: string | null;
  adopt: Array<{ seq: number; blob: string }>;
  presence: string | null;
}

const EMPTY: Entries = new Map();

/** Our local log (trusted: written by this OS user): its ops tree, shards and next seq. */
async function localLog(deps: Deps, repo: string, localRoot: string | null): Promise<{ ops: string | null; shards: Entries; next: number; root: Entries }> {
  const root = localRoot ? await treeEntries(deps, repo, localRoot) : EMPTY;
  const ops = root.get('ops')?.oid ?? null;
  const shards = ops ? await treeEntries(deps, repo, ops) : EMPTY;
  const last = [...shards.keys()].filter((s) => SHARD_RE.test(s)).sort().pop();
  if (!last) return { ops, shards, next: 0, root };
  const seqs = [...(await treeEntries(deps, repo, shards.get(last)!.oid)).keys()]
    .map((n) => SEG_FILE_RE.exec(n)?.[1]).filter((x): x is string => Boolean(x)).map(Number);
  return { ops, shards, next: seqs.length ? Math.max(...seqs) + 1 : 0, root };
}

const hashOf = (view: GitView, seq: number, data: Buffer | undefined): string | null =>
  data ? segmentContentHash(data, view.git.teamKey, { teamId: view.git.teamId, agent: view.git.agentId, seq }) : null;

async function readOwnPresence(deps: Deps, repo: string, view: GitView, info: ObjInfo | null | undefined): Promise<Presence | null> {
  if (!info || info.type !== 'blob' || info.size > MAX_PRESENCE_BYTES) return null;
  const [buf] = await readSizedBlobs(deps, repo, [info]);
  const { teamKey, teamId, agentId, publicKey } = view.git;
  return decodePresence(buf!, teamKey, teamId, agentId, publicKey);
}

/**
 * Our seqs at their expected paths on the remote. Returns the seqs that are missing and those whose blob differs
 * from ours (decided by content later). Cost: one lookup per our shard, plus one per our seq in differing shards.
 */
async function checkOurSeqs(
  deps: Deps, repo: string, t: TipTree, local: { ops: string | null; shards: Entries },
): Promise<{ missing: number[]; present: number[]; differs: Array<{ seq: number; ours: string; theirs: ObjInfo }> }> {
  const out = { missing: [] as number[], present: [] as number[], differs: [] as Array<{ seq: number; ours: string; theirs: ObjInfo }> };
  if (!local.ops || t.ops === local.ops) return out;
  const shards = [...local.shards.keys()].filter((s) => SHARD_RE.test(s)).sort();
  const remote = t.ops ? await objectInfo(deps, repo, shards.map((s) => `${t.ops}:${s}`)) : shards.map(() => null);
  for (let i = 0; i < shards.length; i++) {
    const mine = await treeEntries(deps, repo, local.shards.get(shards[i]!)!.oid);
    const files = [...mine.keys()].filter((n) => SEG_FILE_RE.test(n)).sort();
    const seqs = files.map((n) => Number(SEG_FILE_RE.exec(n)![1]));
    const r = remote[i];
    if (r?.oid === local.shards.get(shards[i]!)!.oid) { out.present.push(...seqs); continue; }
    if (!r || r.type !== 'tree' || r.size > MAX_SHARD_TREE_BYTES) { out.missing.push(...seqs); continue; }
    const infos = await objectInfo(deps, repo, files.map((f) => `${r.oid}:${f}`));
    files.forEach((f, k) => {
      const theirs = infos[k];
      if (!theirs) out.missing.push(seqs[k]!);
      else {
        out.present.push(seqs[k]!);
        if (theirs.oid !== mine.get(f)!.oid) out.differs.push({ seq: seqs[k]!, ours: mine.get(f)!.oid, theirs });
      }
    });
  }
  return out;
}

/** Remote seqs from `next` on that verify under our key, contiguous; stops at the first missing or bad one. */
async function adoptable(deps: Deps, repo: string, view: GitView, t: TipTree, next: number): Promise<{ adopt: Array<{ seq: number; blob: string }>; bad: boolean }> {
  const adopt: Array<{ seq: number; blob: string }> = [];
  const shards = new Map<string, string | null>();
  for (let seq = next; ;) {
    const { found, end } = await lookupSeqs(deps, repo, t, shards, seq, ADOPT_BATCH);
    const firstBad = found.findIndex((f) => f.info.type !== 'blob' || f.info.size > MAX_SEGMENT_BYTES);
    const ok = firstBad < 0 ? found : found.slice(0, firstBad);
    const blobs = await readSizedBlobs(deps, repo, ok.map((f) => f.info));
    for (let i = 0; i < ok.length; i++) {
      if (typeof (await verifySegment(view, view.git.agentId, view.git.publicKey, ok[i]!.seq, blobs[i]!)) === 'string') return { adopt, bad: true };
      adopt.push({ seq: ok[i]!.seq, blob: ok[i]!.info.oid });
    }
    if (ok.length < found.length) return { adopt, bad: true };
    if (end) return { adopt, bad: false };
    seq += found.length;
  }
}

/** Compares the (guarded) remote tree with our local one at the expected paths only. */
async function compare(deps: Deps, repo: string, view: GitView, t: TipTree, localRoot: string | null): Promise<Comparison> {
  const out: Comparison = { vandalised: false, conflict: null, adopt: [], presence: null };
  const remoteRoot = await treeEntries(deps, repo, t.root); // guarded: at most 4 KiB
  if ([...remoteRoot.keys()].some((n) => n !== 'ops' && n !== 'presence.bin')) out.vandalised = true;
  const local = await localLog(deps, repo, localRoot);
  const ours = await checkOurSeqs(deps, repo, t, local);
  // A missing seq below one that is present: truncated in the middle. A missing suffix: the remote is just behind.
  const maxPresent = Math.max(-1, ...ours.present);
  if (ours.missing.some((q) => q < maxPresent)) out.vandalised = true;
  if (ours.differs.length > 0) {
    const theirs = await readSizedBlobs(deps, repo, ours.differs.map((d) => d.theirs).filter((i) => i.type === 'blob' && i.size <= MAX_SEGMENT_BYTES));
    const mine = await readSizedBlobs(deps, repo, (await objectInfo(deps, repo, ours.differs.map((d) => d.ours))).map((i) => i!));
    let k = 0;
    for (let i = 0; i < ours.differs.length; i++) {
      const d = ours.differs[i]!;
      const data = d.theirs.type === 'blob' && d.theirs.size <= MAX_SEGMENT_BYTES ? theirs[k++] : undefined;
      const h = hashOf(view, d.seq, data);
      out.vandalised = true; // a re-encrypted copy or junk: restore ours
      if (h !== null && h !== hashOf(view, d.seq, mine[i]) && typeof (await verifySegment(view, view.git.agentId, view.git.publicKey, d.seq, data!)) !== 'string') {
        out.conflict = `seq ${d.seq}`;
        return out;
      }
    }
  }
  // Our own segments after our last one (only when the remote is not behind us).
  if (ours.missing.length === 0) {
    const a = await adoptable(deps, repo, view, t, local.next);
    out.adopt = a.adopt;
    if (a.bad) out.vandalised = true;
  }
  // Presence: theirs must verify under our key; a newer one is adopted.
  const theirsP = remoteRoot.get('presence.bin');
  const oursP = local.root.get('presence.bin');
  if (theirsP && theirsP.oid !== oursP?.oid) {
    const [ti, oi] = await objectInfo(deps, repo, [theirsP.oid, ...(oursP ? [oursP.oid] : [])]);
    const p = await readOwnPresence(deps, repo, view, ti);
    if (!p) out.vandalised = true;
    else if (isNewer(p, (await readOwnPresence(deps, repo, view, oi)) ?? undefined)) out.presence = theirsP.oid;
  }
  // Every expected path matched and nothing was adopted, yet the ops trees differ: extra junk somewhere in ops.
  if (!out.vandalised && ours.missing.length === 0 && out.adopt.length === 0 && t.ops !== local.ops) out.vandalised = true;
  return out;
}

/**
 * Checks our remote log against our local one, adopting our own remote segments and presence (see the header).
 * `pruned`: our ref was deleted on the remote this round. Never throws except a lost lock or a moved ref; problems
 * and the conflict error go into `report`.
 */
export async function checkOwnRemote(
  deps: Deps, repo: string, view: GitView, lock: SyncLock, pruned: boolean, report: { problems: string[]; errors: string[] },
): Promise<OwnRemote> {
  const { teamId, agentId } = view.git;
  const observed = await fetchedAgentHead(deps, repo, teamId, agentId);
  const base: OwnRemote = { observed, remoteRoot: null, vandalised: false, conflict: null };
  if (!observed) {
    const local = await localAgentHead(deps, repo, teamId, agentId);
    if (pruned && local) report.problems.push('our own log was deleted from the remote; restoring it');
    return { ...base, vandalised: pruned && local !== null };
  }
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

