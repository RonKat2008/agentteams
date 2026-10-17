import type { CliDeps } from '../deps.js';
import { MAX_SEGMENT_BYTES } from './segment.js';

/**
 * Git plumbing for the serverless op log. Everything here talks to hidden refs only:
 * no branches, no index, no working tree, no dependency on user git config.
 * Segments are opaque Buffers (encoding/encryption is another layer).
 */
type GitDeps = Pick<CliDeps, 'exec'>;

export interface PushResult { ok: boolean; error?: string }
export interface Segment { seq: number; data: Buffer }

const ID_RE = /^[0-9A-Za-z]{10,40}$/;
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
async function commitOn(deps: GitDeps, repo: string, ref: string, parent: string | null, root: Entry[]): Promise<void> {
  const tree = await mktree(deps, repo, root);
  const args = ['commit-tree', tree, '-m', COMMIT_MESSAGE, ...(parent ? ['-p', parent] : [])];
  const commit = (await gitOk(deps, repo, args)).stdout.trim();
  await gitOk(deps, repo, ['update-ref', ref, commit, ...(parent ? [parent] : [])]);
}

/** Add or replace one file (optionally inside a subdirectory) in the log tree behind `ref`. */
/** Thrown when a local ref moved under us (compare-and-swap failure): the caller must stop. */
export class RefMovedError extends Error {
  constructor(ref: string) {
    super(`local ref ${ref} moved unexpectedly; stopping`);
    this.name = 'RefMovedError';
  }
}

async function putFile(
  deps: GitDeps, repo: string, ref: string, dir: string | null, name: string, data: Buffer, expected?: string | null,
): Promise<void> {
  const parent = await resolveRef(deps, repo, ref);
  if (expected !== undefined && parent !== expected) throw new RefMovedError(ref);
  const root = parent ? await lsTree(deps, repo, parent, true) : [];
  const blob = blobEntry(name, await writeBlob(deps, repo, data));
  if (!dir) return commitOn(deps, repo, ref, parent, withEntry(root, blob));
  const sub = root.find((e) => e.name === dir && e.type === 'tree');
  const subEntries = sub ? await lsTree(deps, repo, sub.sha, true) : [];
  const subSha = await mktree(deps, repo, withEntry(subEntries, blob));
  const subEntry: Entry = { mode: MODE_TREE, type: 'tree', sha: subSha, name: dir };
  return commitOn(deps, repo, ref, parent, withEntry(root, subEntry));
}

const segName = (seq: number) => `${String(seq).padStart(SEQ_PAD, '0')}.bin`;

/**
 * Appends a segment to our local log. With `expectedTip` (null = the log must not exist yet) the write is a
 * compare-and-swap: RefMovedError if the log is not at that commit (the final update-ref is CAS on the parent too).
 */
export async function appendSegment(
  deps: GitDeps, repo: string, teamId: string, agentId: string, seq: number, data: Buffer, expectedTip?: string | null,
): Promise<void> {
  assertId('team', teamId); assertId('agent', agentId); assertSeq(seq);
  await putFile(deps, repo, localAgent(teamId, agentId), OPS_DIR, segName(seq), data, expectedTip);
}

export async function setPresence(
  deps: GitDeps, repo: string, teamId: string, agentId: string, data: Buffer, expectedTip?: string | null,
): Promise<void> {
  assertId('team', teamId); assertId('agent', agentId);
  await putFile(deps, repo, localAgent(teamId, agentId), null, PRESENCE_FILE, data, expectedTip);
}

export async function writeMeta(deps: GitDeps, repo: string, teamId: string, data: Buffer): Promise<void> {
  assertId('team', teamId);
  await putFile(deps, repo, localMeta(teamId), null, META_FILE, data);
}

async function readFileAt(deps: GitDeps, repo: string, ref: string, path: string): Promise<Buffer | null> {
  const r = await git(deps, repo, ['cat-file', 'blob', `${ref}:${path}`], { binary: true });
  return r.code === 0 ? (r.stdoutBuf ?? Buffer.alloc(0)) : null;
}

/** Locally written meta wins (it is the creator's newest); otherwise the fetched copy. */
export async function readMeta(deps: GitDeps, repo: string, teamId: string): Promise<Buffer | null> {
  assertId('team', teamId);
  return (await readFileAt(deps, repo, localMeta(teamId), META_FILE)) ?? (await readFileAt(deps, repo, fetchedMeta(teamId), META_FILE));
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

async function pushRef(deps: GitDeps, repo: string, remote: string, local: string, dest: string): Promise<PushResult> {
  validateRemote(remote);
  if (!(await resolveRef(deps, repo, local))) return { ok: false, error: `nothing to push: ${local} does not exist` };
  // No leading '+': non-fast-forward updates are rejected.
  const r = await git(deps, repo, ['push', '--quiet', '--', remote, `${local}:${dest}`], { env: networkEnv(), timeoutMs: NETWORK_TIMEOUT_MS });
  return r.code === 0 ? { ok: true } : failure(r);
}

export function pushOwn(deps: GitDeps, repo: string, remote: string, teamId: string, agentId: string): Promise<PushResult> {
  assertId('team', teamId); assertId('agent', agentId);
  return pushRef(deps, repo, remote, localAgent(teamId, agentId), remoteAgent(teamId, agentId));
}

export function pushMeta(deps: GitDeps, repo: string, remote: string, teamId: string): Promise<PushResult> {
  assertId('team', teamId);
  return pushRef(deps, repo, remote, localMeta(teamId), remoteMeta(teamId));
}

async function refNames(deps: GitDeps, repo: string, prefix: string): Promise<string[]> {
  const r = await git(deps, repo, ['for-each-ref', '--format=%(refname)', prefix]);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((n) => n.slice(prefix.length)).filter((id) => ID_RE.test(id));
}

/** Agents known from fetched refs plus our own local logs, sorted and de-duplicated. */
export async function listAgents(deps: GitDeps, repo: string, teamId: string): Promise<string[]> {
  assertId('team', teamId);
  const [remote, local] = await Promise.all([
    refNames(deps, repo, `refs/agentteams-remote/${teamId}/agents/`),
    refNames(deps, repo, `refs/agentteams-local/${teamId}/agents/`),
  ]);
  return [...new Set([...remote, ...local])].sort();
}

/** The local log wins when it exists (always at least as new as our pushed copy); otherwise the fetched copy. */
async function agentRef(deps: GitDeps, repo: string, teamId: string, agentId: string): Promise<string | null> {
  const local = localAgent(teamId, agentId);
  if (await resolveRef(deps, repo, local)) return local;
  const fetched = fetchedAgent(teamId, agentId);
  return (await resolveRef(deps, repo, fetched)) ? fetched : null;
}

/** Segments with `seq >= fromSeq`, in ascending seq order. Throws if a segment blob exceeds MAX_SEGMENT_BYTES. */
export async function readSegments(deps: GitDeps, repo: string, teamId: string, agentId: string, fromSeq: number): Promise<Segment[]> {
  assertId('team', teamId); assertId('agent', agentId);
  const ref = await agentRef(deps, repo, teamId, agentId);
  if (!ref) return [];
  const out: Segment[] = [];
  for (const s of await readSegmentsAt(deps, repo, ref, fromSeq)) {
    if (s.data === null) throw new Error(`segment ${s.seq} is ${s.size} bytes (limit ${MAX_SEGMENT_BYTES})`);
    out.push({ seq: s.seq, data: s.data });
  }
  return out;
}

/** A segment read from an explicit commit; `data` is null (never read) when the blob is over the size limit. */
export interface CheckedSegment { seq: number; size: number; data: Buffer | null }

/**
 * Segments with `seq >= fromSeq` in the log tree of `commitish`, ascending. Sizes are checked with
 * `cat-file --batch-check` before any blob is read, so an oversized blob never enters memory.
 */
export async function readSegmentsAt(deps: GitDeps, repo: string, commitish: string, fromSeq: number): Promise<CheckedSegment[]> {
  const wanted: { seq: number; sha: string }[] = [];
  for (const e of await lsTree(deps, repo, `${commitish}:${OPS_DIR}`)) {
    const m = /^(\d{8})\.bin$/.exec(e.name);
    if (m && e.type === 'blob' && Number(m[1]) >= fromSeq) wanted.push({ seq: Number(m[1]), sha: e.sha });
  }
  wanted.sort((x, y) => x.seq - y.seq);
  if (wanted.length === 0) return [];
  const sizes = await blobSizes(deps, repo, wanted.map((w) => w.sha));
  const small = wanted.filter((_, i) => sizes[i]! <= MAX_SEGMENT_BYTES);
  const blobs = small.length === 0 ? [] : parseBatch(
    (await gitOk(deps, repo, ['cat-file', '--batch'], { input: `${small.map((w) => w.sha).join('\n')}\n`, binary: true })).stdoutBuf ?? Buffer.alloc(0),
    small.length,
  );
  const bySha = new Map(small.map((w, i) => [w.sha, blobs[i]!]));
  return wanted.map((w, i) => ({ seq: w.seq, size: sizes[i]!, data: sizes[i]! <= MAX_SEGMENT_BYTES ? bySha.get(w.sha)! : null }));
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

/** Blob sizes via `cat-file --batch-check` (one process for all). Missing or non-blob objects throw. */
async function blobSizes(deps: GitDeps, repo: string, shas: string[]): Promise<number[]> {
  const r = await gitOk(deps, repo, ['cat-file', '--batch-check'], { input: `${shas.join('\n')}\n` });
  const lines = r.stdout.split('\n').filter(Boolean);
  if (lines.length !== shas.length) throw new Error('git cat-file --batch-check: unexpected output');
  return lines.map((line) => {
    const [, type, size] = line.split(' ');
    if (type !== 'blob' || !/^\d+$/.test(size ?? '')) throw new Error(`git cat-file --batch-check: unexpected "${line}"`);
    return Number(size);
  });
}

export async function readPresence(deps: GitDeps, repo: string, teamId: string, agentId: string): Promise<Buffer | null> {
  assertId('team', teamId); assertId('agent', agentId);
  const ref = await agentRef(deps, repo, teamId, agentId);
  return ref ? readPresenceAt(deps, repo, ref) : null;
}

/** Largest presence blob that is read; anything bigger is ignored (presence is a few hundred bytes). */
export const MAX_PRESENCE_BYTES = 64 * 1024;

/** presence.bin of an explicit commit; null when absent or over MAX_PRESENCE_BYTES (checked before reading). */
export async function readPresenceAt(deps: GitDeps, repo: string, commitish: string): Promise<Buffer | null> {
  const size = await git(deps, repo, ['cat-file', '-s', `${commitish}:${PRESENCE_FILE}`]);
  if (size.code !== 0 || Number(size.stdout.trim()) > MAX_PRESENCE_BYTES) return null;
  return readFileAt(deps, repo, commitish, PRESENCE_FILE);
}

// ---- Explicit heads (used by the sync engine) ------------------------------------------------------

/** Commit of this agent's own local log, or null. */
export function localAgentHead(deps: GitDeps, repo: string, teamId: string, agentId: string): Promise<string | null> {
  assertId('team', teamId); assertId('agent', agentId);
  return resolveRef(deps, repo, localAgent(teamId, agentId));
}

/** Commit of the last fetched copy of an agent's log, or null. */
export function fetchedAgentHead(deps: GitDeps, repo: string, teamId: string, agentId: string): Promise<string | null> {
  assertId('team', teamId); assertId('agent', agentId);
  return resolveRef(deps, repo, fetchedAgent(teamId, agentId));
}

/** Agents with a fetched ref (not our own local logs), sorted. */
export function listFetchedAgents(deps: GitDeps, repo: string, teamId: string): Promise<string[]> {
  assertId('team', teamId);
  return refNames(deps, repo, `refs/agentteams-remote/${teamId}/agents/`).then((ids) => ids.sort());
}

export const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. Throws when git cannot tell. */
export async function isAncestor(deps: GitDeps, repo: string, ancestor: string, descendant: string): Promise<boolean> {
  if (!SHA_RE.test(ancestor) || !SHA_RE.test(descendant)) throw new Error('isAncestor: invalid commit id');
  const r = await git(deps, repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`git merge-base failed: ${r.stderr.trim()}`);
}

const ZERO_SHA = '0'.repeat(40);

/** `update-ref <ref> <new> [<old>]`; with `expected` (null = must not exist) it is a compare-and-swap. */
async function setRef(deps: GitDeps, repo: string, ref: string, sha: string, expected?: string | null): Promise<void> {
  if (!SHA_RE.test(sha) || (expected && !SHA_RE.test(expected))) throw new Error(`invalid commit: ${JSON.stringify(sha)}`);
  const args = ['update-ref', ref, sha, ...(expected === undefined ? [] : [expected ?? ZERO_SHA])];
  const r = await git(deps, repo, args);
  if (r.code !== 0) {
    if (expected !== undefined) throw new RefMovedError(ref);
    throw new Error(`git update-ref failed: ${r.stderr.trim()}`);
  }
}

/** Points our local log at `sha` (re-seeding it from the fetched copy), as a CAS from `expected` (null = absent). */
export function setLocalAgentHead(
  deps: GitDeps, repo: string, teamId: string, agentId: string, sha: string, expected: string | null,
): Promise<void> {
  assertId('team', teamId); assertId('agent', agentId);
  return setRef(deps, repo, localAgent(teamId, agentId), sha, expected);
}

/** Records that the remote now has `sha` for our ref (after a successful push), so the next round can skip pushing. */
export function setFetchedAgentHead(deps: GitDeps, repo: string, teamId: string, agentId: string, sha: string): Promise<void> {
  assertId('team', teamId); assertId('agent', agentId);
  return setRef(deps, repo, fetchedAgent(teamId, agentId), sha);
}

/**
 * Keeps the last accepted commit of an agent's log reachable (`refs/agentteams-seen/...`): fetches force-update the
 * fetched refs, so a rejected rewrite must not let the accepted chain be garbage-collected.
 */
export function setSeenAgentHead(deps: GitDeps, repo: string, teamId: string, agentId: string, sha: string): Promise<void> {
  assertId('team', teamId); assertId('agent', agentId);
  return setRef(deps, repo, `refs/agentteams-seen/${teamId}/agents/${agentId}`, sha);
}

/** Sequence numbers present in a log tree, ascending (no blob reads). */
export async function segmentSeqsAt(deps: GitDeps, repo: string, commitish: string): Promise<number[]> {
  const seqs: number[] = [];
  for (const e of await lsTree(deps, repo, `${commitish}:${OPS_DIR}`)) {
    const m = /^(\d{8})\.bin$/.exec(e.name);
    if (m) seqs.push(Number(m[1]));
  }
  return seqs.sort((a, b) => a - b);
}

/** True when the fetched meta ref exists (the team has been published). */
export async function hasFetchedMeta(deps: GitDeps, repo: string, teamId: string): Promise<boolean> {
  assertId('team', teamId);
  return (await resolveRef(deps, repo, fetchedMeta(teamId))) !== null;
}

/** True when this clone wrote the team's meta locally (it is the creator). */
export async function hasLocalMeta(deps: GitDeps, repo: string, teamId: string): Promise<boolean> {
  assertId('team', teamId);
  return (await resolveRef(deps, repo, localMeta(teamId))) !== null;
}

/** Agents with a log written in this clone (`refs/agentteams-local`), sorted. */
export function listLocalAgents(deps: GitDeps, repo: string, teamId: string): Promise<string[]> {
  assertId('team', teamId);
  return refNames(deps, repo, `refs/agentteams-local/${teamId}/agents/`).then((ids) => ids.sort());
}

/** One file change of a log commit, relative to its first parent. */
export interface LogChange { status: string; path: string; blob: string }

/** Reads blobs whose sizes are already known to be within limits, in one `cat-file --batch`. */
export async function readBlobs(deps: GitDeps, repo: string, shas: string[]): Promise<Buffer[]> {
  if (shas.length === 0) return [];
  if (!shas.every((x) => SHA_RE.test(x))) throw new Error('readBlobs: invalid object id');
  const r = await gitOk(deps, repo, ['cat-file', '--batch'], { input: `${shas.join('\n')}\n`, binary: true });
  return parseBatch(r.stdoutBuf ?? Buffer.alloc(0), shas.length);
}

/** Sizes of blobs (`cat-file --batch-check`), checked before any read. */
export function sizesOf(deps: GitDeps, repo: string, shas: string[]): Promise<number[]> {
  if (!shas.every((x) => SHA_RE.test(x))) return Promise.reject(new Error('sizesOf: invalid object id'));
  return shas.length === 0 ? Promise.resolve([]) : blobSizes(deps, repo, shas);
}

/**
 * Restores our own ref on the remote after vandalism: force-pushes our local log, but only if the remote still
 * points at `observed` (`--force-with-lease`), so a concurrent legitimate update is never overwritten.
 */
export async function restoreOwn(
  deps: GitDeps, repo: string, remote: string, teamId: string, agentId: string, observed: string,
): Promise<PushResult> {
  assertId('team', teamId); assertId('agent', agentId);
  validateRemote(remote);
  if (!SHA_RE.test(observed)) throw new Error('restoreOwn: invalid commit id');
  const local = localAgent(teamId, agentId);
  if (!(await resolveRef(deps, repo, local))) return { ok: false, error: 'nothing to restore' };
  const dest = remoteAgent(teamId, agentId);
  const r = await git(deps, repo, ['push', '--quiet', `--force-with-lease=${dest}:${observed}`, '--', remote, `${local}:${dest}`],
    { env: networkEnv(), timeoutMs: NETWORK_TIMEOUT_MS });
  return r.code === 0 ? { ok: true } : failure(r);
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

// ---- Bounded chain inspection (fix round 2) -----------------------------------------------------------

const rangeArgs = (from: string | null, to: string): string[] => {
  if (!SHA_RE.test(to) || (from !== null && !SHA_RE.test(from))) throw new Error('invalid commit id');
  return from ? [`${from}..${to}`] : [to];
};

/** Number of first-parent commits in `from..to` (output is one number, whatever the chain). */
export async function countCommits(deps: GitDeps, repo: string, from: string | null, to: string): Promise<number> {
  const r = await gitOk(deps, repo, ['rev-list', '--first-parent', '--count', ...rangeArgs(from, to), '--'], { maxBytes: 64 });
  const n = Number(r.stdout.trim());
  if (!Number.isSafeInteger(n)) throw new Error('git rev-list: unexpected output');
  return n;
}

/** The OLDEST `take` first-parent commits of `from..to` (which has `total`), oldest first. Bounded output. */
export async function oldestCommits(deps: GitDeps, repo: string, from: string | null, to: string, total: number, take: number): Promise<string[]> {
  if (take <= 0) return [];
  const skip = Math.max(0, total - take);
  const r = await gitOk(deps, repo, [
    'rev-list', '--first-parent', `--skip=${skip}`, `--max-count=${take}`, ...rangeArgs(from, to), '--',
  ], { maxBytes: take * 42 + 64 });
  const shas = r.stdout.split('\n').filter(Boolean);
  if (!shas.every((x) => SHA_RE.test(x))) throw new Error('git rev-list: unexpected output');
  return shas.reverse();
}

/** Per-commit diff output limit: an honest log commit changes one file (about 150 bytes). */
const MAX_DIFF_BYTES = 4096;

export type CommitChanges = LogChange[] | 'too-large';

function parseDiffTree(out: string): Map<string, LogChange[]> {
  const byCommit = new Map<string, LogChange[]>();
  const tokens = out.split('\0');
  let current: LogChange[] | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.replace(/^\n/, '');
    if (!t) continue;
    if (SHA_RE.test(t)) { current = []; byCommit.set(t, current); continue; }
    const m = /^:\d{6} \d{6} [0-9a-f]+ ([0-9a-f]+) ([A-Z])\d*$/.exec(t);
    if (m && current) {
      current.push({ blob: m[1]!, status: m[2]!, path: tokens[++i] ?? '' });
      continue;
    }
    throw new Error('git diff-tree: unexpected output');
  }
  return byCommit;
}

/**
 * The changes of each commit against its first parent (root commits against the empty tree), with bounded output:
 * a commit whose diff exceeds MAX_DIFF_BYTES is reported as 'too-large' (never read in full). Empty commits map to [].
 */
export async function commitChanges(deps: GitDeps, repo: string, shas: string[]): Promise<Map<string, CommitChanges>> {
  if (!shas.every((x) => SHA_RE.test(x))) throw new Error('commitChanges: invalid commit id');
  const result = new Map<string, CommitChanges>(shas.map((x) => [x, []]));
  const args = ['diff-tree', '--stdin', '-r', '--raw', '--no-abbrev', '--no-renames', '--root', '-m', '--first-parent', '-z'];
  const all = await git(deps, repo, args, { input: `${shas.join('\n')}\n`, maxBytes: MAX_DIFF_BYTES * Math.max(1, shas.length) });
  if (all.code === 0) {
    for (const [sha, changes] of parseDiffTree(all.stdout)) if (result.has(sha)) result.set(sha, changes);
    return result;
  }
  // Something is oversized (or odd): go commit by commit so the honest ones before it still count.
  for (const sha of shas) {
    const one = await git(deps, repo, args, { input: `${sha}\n`, maxBytes: MAX_DIFF_BYTES });
    if (one.code !== 0) { result.set(sha, 'too-large'); break; }
    result.set(sha, parseDiffTree(one.stdout).get(sha) ?? []);
  }
  return result;
}

/** Object id of the fetched meta ref, whatever its type (a non-commit meta is still "present"). */
export async function fetchedMetaObject(deps: GitDeps, repo: string, teamId: string): Promise<string | null> {
  assertId('team', teamId);
  const r = await git(deps, repo, ['rev-parse', '--verify', '-q', fetchedMeta(teamId)]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Creator only: puts our (write-once) meta back on the remote when the remote copy is vandalised. Leased on the
 * observed remote object, so a concurrent change makes it fail rather than overwrite.
 */
export async function restoreMeta(deps: GitDeps, repo: string, remote: string, teamId: string, observed: string): Promise<PushResult> {
  assertId('team', teamId);
  validateRemote(remote);
  if (!SHA_RE.test(observed)) throw new Error('restoreMeta: invalid object id');
  const local = localMeta(teamId);
  if (!(await resolveRef(deps, repo, local))) return { ok: false, error: 'no local meta' };
  const dest = remoteMeta(teamId);
  const r = await git(deps, repo, ['push', '--quiet', `--force-with-lease=${dest}:${observed}`, '--', remote, `${local}:${dest}`],
    { env: networkEnv(), timeoutMs: NETWORK_TIMEOUT_MS });
  return r.code === 0 ? { ok: true } : failure(r);
}

/** A presence blob by object id, size-checked first; null when missing or over MAX_PRESENCE_BYTES. */
export async function readPresenceBlob(deps: GitDeps, repo: string, blob: string): Promise<Buffer | null> {
  if (!SHA_RE.test(blob)) return null;
  const [size] = await sizesOf(deps, repo, [blob]).catch(() => [Infinity]);
  if (size === undefined || size > MAX_PRESENCE_BYTES) return null;
  return (await readBlobs(deps, repo, [blob]))[0] ?? null;
}
