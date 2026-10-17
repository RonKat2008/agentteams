import type { CliDeps } from '../deps.js';
import { MAX_SEGMENT_BYTES } from './segment.js';

/**
 * Git plumbing for the serverless op log. Everything here talks to hidden refs only:
 * no branches, no index, no working tree, no dependency on user git config.
 * Segments are opaque Buffers (encoding/encryption is another layer). Readers address a log by path in its tip
 * tree (see "Log layout"); commit history is written (one commit per change) but never read.
 */
type GitDeps = Pick<CliDeps, 'exec'>;

export interface PushResult { ok: boolean; error?: string }

const ID_RE = /^[0-9A-Za-z]{10,40}$/;
export const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ZERO_SHA = '0'.repeat(40);
const SEQ_PAD = 8;
const COMMIT_MESSAGE = 'agentteams';
const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'agentteams', GIT_AUTHOR_EMAIL: 'agentteams@localhost',
  GIT_COMMITTER_NAME: 'agentteams', GIT_COMMITTER_EMAIL: 'agentteams@localhost',
};
const MODE_BLOB = '100644';
const MODE_TREE = '040000';
const OPS_DIR = 'ops';
const PRESENCE_FILE = 'presence.bin';
const META_FILE = 'meta.bin';

function assertId(kind: string, id: string): void {
  if (!ID_RE.test(id)) throw new Error(`invalid ${kind} id: ${JSON.stringify(id)}`);
}
function assertSeq(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= 10 ** SEQ_PAD) throw new Error(`invalid seq: ${seq}`);
}

const remoteMeta = (t: string) => `refs/agentteams/${t}/meta`;
const remoteAgent = (t: string, a: string) => `refs/agentteams/${t}/agents/${a}`;
const localMeta = (t: string) => `refs/agentteams-local/${t}/meta`;
const localAgent = (t: string, a: string) => `refs/agentteams-local/${t}/agents/${a}`;
const fetchedMeta = (t: string) => `refs/agentteams-remote/${t}/meta`;
const fetchedAgent = (t: string, a: string) => `refs/agentteams-remote/${t}/agents/${a}`;

const NETWORK_TIMEOUT_MS = 20_000;
const ALLOWED_PROTOCOLS = 'file:git:http:https:ssh';

interface RunOpts { input?: string | Buffer; binary?: boolean; env?: Record<string, string>; timeoutMs?: number; maxBytes?: number }

/** `remote` may come from an invite code, so it is attacker-controlled. */
export function validateRemote(remote: string): void {
  if (typeof remote !== 'string' || remote.length === 0) throw new Error('invalid remote: empty');
  if (remote.startsWith('-')) throw new Error('invalid remote: must not start with "-"');
  if (/[\0\r\n]/.test(remote)) throw new Error('invalid remote: control characters');
  if (/^(ext|fd)::/i.test(remote)) throw new Error('invalid remote: transport not allowed');
}

function networkEnv(): Record<string, string> {
  return {
    GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS,
    GIT_TERMINAL_PROMPT: '0',
    ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' }),
  };
}

function git(deps: GitDeps, repo: string, args: string[], opts: RunOpts = {}) {
  const { env, ...rest } = opts;
  return deps.exec('git', args, { cwd: repo, env: { ...IDENTITY_ENV, ...env }, ...rest });
}

async function gitOk(deps: GitDeps, repo: string, args: string[], opts: RunOpts = {}) {
  const r = await git(deps, repo, args, opts);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r;
}

async function resolveRef(deps: GitDeps, repo: string, ref: string): Promise<string | null> {
  const r = await git(deps, repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

interface Entry { mode: string; type: string; sha: string; name: string }

/** Entries of `<treeish>`. Strict callers (the write path) throw on any git error; lenient readers get []. */
async function lsTree(deps: GitDeps, repo: string, treeish: string, strict = false): Promise<Entry[]> {
  const r = await git(deps, repo, ['ls-tree', '-z', treeish]);
  if (r.code !== 0) {
    if (strict) throw new Error(`git ls-tree ${treeish} failed: ${r.stderr.trim()}`);
    return [];
  }
  return r.stdout.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, sha] = line.slice(0, tab).split(' ');
    return { mode: mode!, type: type!, sha: sha!, name: line.slice(tab + 1) };
  });
}

async function mktree(deps: GitDeps, repo: string, entries: Entry[]): Promise<string> {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const input = sorted.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}\0`).join('');
  return (await gitOk(deps, repo, ['mktree', '-z'], { input })).stdout.trim();
}

async function writeBlob(deps: GitDeps, repo: string, data: Buffer): Promise<string> {
  return (await gitOk(deps, repo, ['hash-object', '-w', '--stdin'], { input: data })).stdout.trim();
}

const blobEntry = (name: string, sha: string): Entry => ({ mode: MODE_BLOB, type: 'blob', sha, name });
const withEntry = (entries: Entry[], next: Entry): Entry[] => [...entries.filter((e) => e.name !== next.name), next];

/** Commit a new root tree on top of whatever `ref` currently points to. */
async function commitOn(deps: GitDeps, repo: string, ref: string, parent: string | null, root: Entry[]): Promise<string> {
  const tree = await mktree(deps, repo, root);
  const args = ['commit-tree', tree, '-m', COMMIT_MESSAGE, ...(parent ? ['-p', parent] : [])];
  const commit = (await gitOk(deps, repo, args)).stdout.trim();
  const r = await git(deps, repo, ['update-ref', ref, commit, parent ?? ZERO_SHA]);
  if (r.code !== 0) throw new RefMovedError(ref);
  return commit;
}

/** Thrown when a local ref moved under us (compare-and-swap failure): the caller must stop. */
export class RefMovedError extends Error {
  constructor(ref: string) {
    super(`local ref ${ref} moved unexpectedly; stopping`);
    this.name = 'RefMovedError';
  }
}

/** Resolves `ref` and checks it against `expected` (undefined = no check, null = must not exist). */
async function casParent(deps: GitDeps, repo: string, ref: string, expected?: string | null): Promise<string | null> {
  const parent = await resolveRef(deps, repo, ref);
  if (expected !== undefined && parent !== expected) throw new RefMovedError(ref);
  return parent;
}

// ---- Log layout ----------------------------------------------------------------------------------------
//
// An agent's log tree (the tip commit's tree; commit history is never read):
//   presence.bin                      signed {ts, counter}, overwritten
//   ops/<shard>/<seq>.bin             segment `seq`; shard = floor(seq / 1000), 5 digits; seq, 8 digits
// e.g. ops/00000/00000000.bin .. ops/00000/00000999.bin, ops/00001/00001000.bin. Sharding keeps every tree small:
// an append rewrites one shard tree (at most 1000 entries, ~40 KB), never a tree of every segment.

export const SEQ_PER_SHARD = 1000;
const SHARD_PAD = 5;
export const shardOf = (seq: number): string => String(Math.floor(seq / SEQ_PER_SHARD)).padStart(SHARD_PAD, '0');
export const segFile = (seq: number): string => `${String(seq).padStart(SEQ_PAD, '0')}.bin`;
/** Path of segment `seq` inside a log tree. */
export const segPath = (seq: number): string => `${OPS_DIR}/${shardOf(seq)}/${segFile(seq)}`;
export const SHARD_RE = /^\d{5}$/;
export const SEG_FILE_RE = /^(\d{8})\.bin$/;

/** Size guards, checked with `cat-file --batch-check` before any lookup inside the object. */
export const MAX_COMMIT_BYTES = 64 * 1024;
/** The root holds `ops` and `presence.bin` (about 70 bytes). */
export const MAX_ROOT_TREE_BYTES = 4 * 1024;
/** `ops` holds one entry per shard (32 bytes each): about 130,000 shards, far beyond the seq limit. */
export const MAX_OPS_TREE_BYTES = 4 * 1024 * 1024;
/** A shard holds at most 1000 entries of 40 bytes. */
export const MAX_SHARD_TREE_BYTES = 64 * 1024;

/**
 * Adds segment blobs (already in the object store) and optionally replaces presence.bin, as one new commit on
 * `ref`. With `expected` (null = the log must not exist yet) it is a compare-and-swap: RefMovedError if the log is
 * not at that commit (the final update-ref is a CAS on the parent too). Only the touched shard trees are rewritten.
 */
export async function addToLog(
  deps: GitDeps, repo: string, ref: string, items: Array<{ seq: number; blob: string }>, presence: string | null, expected?: string | null,
): Promise<string> {
  const parent = await casParent(deps, repo, ref, expected);
  let root = parent ? await lsTree(deps, repo, parent, true) : [];
  if (items.length > 0) {
    const opsEntry = root.find((e) => e.name === OPS_DIR && e.type === 'tree');
    let ops = opsEntry ? await lsTree(deps, repo, opsEntry.sha, true) : [];
    const byShard = new Map<string, Array<{ seq: number; blob: string }>>();
    for (const it of items) {
      assertSeq(it.seq);
      if (!SHA_RE.test(it.blob)) throw new Error('addToLog: invalid blob id');
      byShard.set(shardOf(it.seq), [...(byShard.get(shardOf(it.seq)) ?? []), it]);
    }
    for (const [shard, list] of byShard) {
      const cur = ops.find((e) => e.name === shard && e.type === 'tree');
      let entries = cur ? await lsTree(deps, repo, cur.sha, true) : [];
      for (const it of list) entries = withEntry(entries, blobEntry(segFile(it.seq), it.blob));
      ops = withEntry(ops, { mode: MODE_TREE, type: 'tree', sha: await mktree(deps, repo, entries), name: shard });
    }
    root = withEntry(root, { mode: MODE_TREE, type: 'tree', sha: await mktree(deps, repo, ops), name: OPS_DIR });
  }
  if (presence) root = withEntry(root, blobEntry(PRESENCE_FILE, presence));
  return commitOn(deps, repo, ref, parent, root);
}

/** Writes blobs to the object store (one `hash-object` per blob). */
export async function writeBlobs(deps: GitDeps, repo: string, data: Buffer[]): Promise<string[]> {
  const out: string[] = [];
  for (const d of data) out.push(await writeBlob(deps, repo, d));
  return out;
}

/** Appends a segment to our local log (see addToLog for `expectedTip`). */
export async function appendSegment(
  deps: GitDeps, repo: string, teamId: string, agentId: string, seq: number, data: Buffer, expectedTip?: string | null,
): Promise<string> {
  assertId('team', teamId); assertId('agent', agentId); assertSeq(seq);
  return addToLog(deps, repo, localAgent(teamId, agentId), [{ seq, blob: await writeBlob(deps, repo, data) }], null, expectedTip);
}

/** Replaces presence.bin in our local log (see addToLog for `expectedTip`). */
export async function setPresence(
  deps: GitDeps, repo: string, teamId: string, agentId: string, data: Buffer, expectedTip?: string | null,
): Promise<string> {
  assertId('team', teamId); assertId('agent', agentId);
  return addToLog(deps, repo, localAgent(teamId, agentId), [], await writeBlob(deps, repo, data), expectedTip);
}

/** Rebuilds our local log from blobs already in the object store (adoption of our own remote segments). */
export async function addToLocalLog(
  deps: GitDeps, repo: string, teamId: string, agentId: string, items: Array<{ seq: number; blob: string }>, presence: string | null,
  expectedTip: string | null,
): Promise<string> {
  assertId('team', teamId); assertId('agent', agentId);
  return addToLog(deps, repo, localAgent(teamId, agentId), items, presence, expectedTip);
}

export async function writeMeta(deps: GitDeps, repo: string, teamId: string, data: Buffer): Promise<void> {
  assertId('team', teamId);
  const ref = localMeta(teamId);
  const parent = await resolveRef(deps, repo, ref);
  const root = parent ? await lsTree(deps, repo, parent, true) : [];
  await commitOn(deps, repo, ref, parent, withEntry(root, blobEntry(META_FILE, await writeBlob(deps, repo, data))));
}

async function readFileAt(deps: GitDeps, repo: string, ref: string, path: string): Promise<Buffer | null> {
  const r = await git(deps, repo, ['cat-file', 'blob', `${ref}:${path}`], { binary: true });
  return r.code === 0 ? (r.stdoutBuf ?? Buffer.alloc(0)) : null;
}

function failure(r: { stderr: string; stdout: string; timedOut?: boolean }): PushResult {
  if (r.timedOut) return { ok: false, error: 'timeout' };
  return { ok: false, error: r.stderr.trim() || r.stdout.trim() || 'git failed' };
}

/** Fetch every team ref into `refs/agentteams-remote/<team>/*`. Never throws on network/remote errors. */
export async function fetchTeam(deps: GitDeps, repo: string, remote: string, teamId: string): Promise<PushResult> {
  assertId('team', teamId);
  validateRemote(remote);
  const spec = `+refs/agentteams/${teamId}/*:refs/agentteams-remote/${teamId}/*`;
  const r = await git(deps, repo, ['fetch', '--quiet', '--no-tags', '--', remote, spec], { env: networkEnv(), timeoutMs: NETWORK_TIMEOUT_MS });
  return r.code === 0 ? { ok: true } : failure(r);
}

async function pushRef(deps: GitDeps, repo: string, remote: string, local: string, dest: string, lease?: string | null): Promise<PushResult> {
  validateRemote(remote);
  if (!(await resolveRef(deps, repo, local))) return { ok: false, error: `nothing to push: ${local} does not exist` };
  if (lease !== undefined && lease !== null && !SHA_RE.test(lease)) throw new Error('push: invalid lease');
  // Without a lease: no leading '+', so non-fast-forward updates are rejected. With one: the remote must still be at
  // `lease` (empty = must not exist), so a concurrent update is never overwritten.
  const leaseArg = lease === undefined ? [] : [`--force-with-lease=${dest}:${lease ?? ''}`];
  const r = await git(deps, repo, ['push', '--quiet', ...leaseArg, '--', remote, `${local}:${dest}`], { env: networkEnv(), timeoutMs: NETWORK_TIMEOUT_MS });
  return r.code === 0 ? { ok: true } : failure(r);
}

/**
 * Pushes our local log over our remote ref, provided the remote is still at `observed` (null = absent). Commit
 * history does not matter to readers (they read by path), so this is always a leased force push: it covers a normal
 * push, a restore after vandalism and a re-clone whose rebuilt log has different commits.
 */
export function pushOwn(deps: GitDeps, repo: string, remote: string, teamId: string, agentId: string, observed: string | null): Promise<PushResult> {
  assertId('team', teamId); assertId('agent', agentId);
  return pushRef(deps, repo, remote, localAgent(teamId, agentId), remoteAgent(teamId, agentId), observed);
}

export function pushMeta(deps: GitDeps, repo: string, remote: string, teamId: string): Promise<PushResult> {
  assertId('team', teamId);
  return pushRef(deps, repo, remote, localMeta(teamId), remoteMeta(teamId));
}

/**
 * Creator only: puts our meta back on the remote when the remote copy is vandalised. Leased on the observed remote
 * object, so a concurrent change makes it fail rather than overwrite.
 */
export async function restoreMeta(deps: GitDeps, repo: string, remote: string, teamId: string, observed: string): Promise<PushResult> {
  assertId('team', teamId);
  if (!SHA_RE.test(observed)) throw new Error('restoreMeta: invalid object id');
  return pushRef(deps, repo, remote, localMeta(teamId), remoteMeta(teamId), observed);
}

// ---- Reading refs and objects (used by the sync engine) ------------------------------------------------

/** Tips of every agent ref under `prefix`: agent id -> object id (whatever its type; callers check). */
async function tipsUnder(deps: GitDeps, repo: string, prefix: string): Promise<Map<string, string>> {
  const r = await git(deps, repo, ['for-each-ref', '--format=%(objectname) %(refname)', prefix]);
  const out = new Map<string, string>();
  if (r.code !== 0) return out;
  for (const line of r.stdout.split('\n')) {
    const sp = line.indexOf(' ');
    const oid = line.slice(0, sp);
    const id = line.slice(sp + 1 + prefix.length);
    if (SHA_RE.test(oid) && ID_RE.test(id)) out.set(id, oid);
  }
  return out;
}

/** Tips of the fetched agent refs (other clones' logs, as last fetched). One git call. */
export function fetchedTips(deps: GitDeps, repo: string, teamId: string): Promise<Map<string, string>> {
  assertId('team', teamId);
  return tipsUnder(deps, repo, `refs/agentteams-remote/${teamId}/agents/`);
}

/** Tips of the logs written in this clone (refs/agentteams-local). One git call. */
export function localTips(deps: GitDeps, repo: string, teamId: string): Promise<Map<string, string>> {
  assertId('team', teamId);
  return tipsUnder(deps, repo, `refs/agentteams-local/${teamId}/agents/`);
}

/** Commit of this agent's own local log, or null. */
export function localAgentHead(deps: GitDeps, repo: string, teamId: string, agentId: string): Promise<string | null> {
  assertId('team', teamId); assertId('agent', agentId);
  return resolveRef(deps, repo, localAgent(teamId, agentId));
}

/** Object id of the last fetched copy of an agent's ref (any type), or null. */
export async function fetchedAgentHead(deps: GitDeps, repo: string, teamId: string, agentId: string): Promise<string | null> {
  assertId('team', teamId); assertId('agent', agentId);
  const r = await git(deps, repo, ['rev-parse', '--verify', '-q', fetchedAgent(teamId, agentId)]);
  return r.code === 0 && SHA_RE.test(r.stdout.trim()) ? r.stdout.trim() : null;
}

/** Records that the remote now has `sha` for our ref (after a successful push), so the next round can skip pushing. */
export async function setFetchedAgentHead(deps: GitDeps, repo: string, teamId: string, agentId: string, sha: string): Promise<void> {
  assertId('team', teamId); assertId('agent', agentId);
  if (!SHA_RE.test(sha)) throw new Error(`invalid commit: ${JSON.stringify(sha)}`);
  await gitOk(deps, repo, ['update-ref', fetchedAgent(teamId, agentId), sha]);
}

/** Tree id of a commit we wrote ourselves (our local log), or null. */
export async function treeOf(deps: GitDeps, repo: string, commit: string): Promise<string | null> {
  if (!SHA_RE.test(commit)) throw new Error('treeOf: invalid commit id');
  const r = await git(deps, repo, ['rev-parse', '--verify', '-q', `${commit}^{tree}`]);
  return r.code === 0 && SHA_RE.test(r.stdout.trim()) ? r.stdout.trim() : null;
}

export interface ObjInfo { oid: string; type: string; size: number }

/**
 * `cat-file --batch-check` for several object specs in one call: null for a missing object. Never parses more than
 * the specs ask for, so callers check a tree's size before naming a path inside it.
 */
export async function objectInfo(deps: GitDeps, repo: string, specs: string[]): Promise<Array<ObjInfo | null>> {
  if (specs.length === 0) return [];
  if (specs.some((s) => /[\s\0]/.test(s) || s.length === 0)) throw new Error('objectInfo: invalid object spec');
  const r = await gitOk(deps, repo, ['cat-file', '--batch-check'], { input: `${specs.join('\n')}\n`, maxBytes: specs.length * 160 + 64 });
  const lines = r.stdout.split('\n').slice(0, specs.length);
  if (lines.length !== specs.length) throw new Error('git cat-file --batch-check: unexpected output');
  return lines.map((line) => {
    const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) ([a-z]+) (\d+)$/.exec(line);
    if (m) return { oid: m[1]!, type: m[2]!, size: Number(m[3]) };
    if (/ (missing|ambiguous)$/.test(line)) return null;
    throw new Error('git cat-file --batch-check: unexpected output');
  });
}

/** Parse `cat-file --batch` output: `<sha> <type> <size>\n<bytes>\n` per object. */
function parseBatch(buf: Buffer, count: number): Buffer[] {
  const out: Buffer[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) throw new Error('git cat-file --batch: truncated output');
    const header = buf.subarray(pos, nl).toString('utf8').split(' ');
    if (header[1] !== 'blob') throw new Error(`git cat-file --batch: unexpected "${header.join(' ')}"`);
    const size = Number(header[2]);
    out.push(Buffer.from(buf.subarray(nl + 1, nl + 1 + size)));
    pos = nl + 1 + size + 1;
  }
  return out;
}

/** Reads blobs whose sizes are already known to be within limits, in one `cat-file --batch`. */
export async function readBlobs(deps: GitDeps, repo: string, shas: string[]): Promise<Buffer[]> {
  if (shas.length === 0) return [];
  if (!shas.every((x) => SHA_RE.test(x))) throw new Error('readBlobs: invalid object id');
  const r = await gitOk(deps, repo, ['cat-file', '--batch'], { input: `${shas.join('\n')}\n`, binary: true });
  return parseBatch(r.stdoutBuf ?? Buffer.alloc(0), shas.length);
}

/** Entries of a tree we already size-checked (or wrote ourselves): name -> {oid, type}. */
export async function treeEntries(deps: GitDeps, repo: string, tree: string): Promise<Map<string, { oid: string; type: string }>> {
  if (!SHA_RE.test(tree)) throw new Error('treeEntries: invalid tree id');
  const out = new Map<string, { oid: string; type: string }>();
  for (const e of await lsTree(deps, repo, tree, true)) out.set(e.name, { oid: e.sha, type: e.type });
  return out;
}

/** Largest presence blob that is read; anything bigger is refused unread (presence is a few hundred bytes). */
export const MAX_PRESENCE_BYTES = 64 * 1024;

/** Object id of the fetched meta ref, whatever its type (a non-commit meta is still "present"). */
export async function fetchedMetaObject(deps: GitDeps, repo: string, teamId: string): Promise<string | null> {
  assertId('team', teamId);
  const r = await git(deps, repo, ['rev-parse', '--verify', '-q', fetchedMeta(teamId)]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** The fetched meta (what the remote holds), size-checked; null when absent or oversized. */
export async function readFetchedMeta(deps: GitDeps, repo: string, teamId: string, maxBytes: number): Promise<Buffer | null> {
  assertId('team', teamId);
  return readSmallFile(deps, repo, fetchedMeta(teamId), META_FILE, maxBytes);
}

/** The meta this clone wrote (it is the creator), size-checked; null when absent. */
export async function readLocalMeta(deps: GitDeps, repo: string, teamId: string, maxBytes: number): Promise<Buffer | null> {
  assertId('team', teamId);
  return readSmallFile(deps, repo, localMeta(teamId), META_FILE, maxBytes);
}

async function readSmallFile(deps: GitDeps, repo: string, ref: string, path: string, maxBytes: number): Promise<Buffer | null> {
  if (!(await resolveRef(deps, repo, ref))) return null;
  const size = await git(deps, repo, ['cat-file', '-s', `${ref}:${path}`]);
  if (size.code !== 0 || Number(size.stdout.trim()) > maxBytes) return null;
  return readFileAt(deps, repo, ref, path);
}
