import type { CliDeps } from '../deps.js';

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

interface RunOpts { input?: string | Buffer; binary?: boolean; env?: Record<string, string>; timeoutMs?: number }

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
async function putFile(deps: GitDeps, repo: string, ref: string, dir: string | null, name: string, data: Buffer): Promise<void> {
  const parent = await resolveRef(deps, repo, ref);
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

export async function appendSegment(deps: GitDeps, repo: string, teamId: string, agentId: string, seq: number, data: Buffer): Promise<void> {
  assertId('team', teamId); assertId('agent', agentId); assertSeq(seq);
  await putFile(deps, repo, localAgent(teamId, agentId), OPS_DIR, segName(seq), data);
}

export async function setPresence(deps: GitDeps, repo: string, teamId: string, agentId: string, data: Buffer): Promise<void> {
  assertId('team', teamId); assertId('agent', agentId);
  await putFile(deps, repo, localAgent(teamId, agentId), null, PRESENCE_FILE, data);
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

/** Segments with `seq >= fromSeq`, in ascending seq order. */
export async function readSegments(deps: GitDeps, repo: string, teamId: string, agentId: string, fromSeq: number): Promise<Segment[]> {
  assertId('team', teamId); assertId('agent', agentId);
  const ref = await agentRef(deps, repo, teamId, agentId);
  if (!ref) return [];
  const wanted: { seq: number; sha: string }[] = [];
  for (const e of await lsTree(deps, repo, `${ref}:${OPS_DIR}`)) {
    const m = /^(\d{8})\.bin$/.exec(e.name);
    if (m && Number(m[1]) >= fromSeq) wanted.push({ seq: Number(m[1]), sha: e.sha });
  }
  wanted.sort((x, y) => x.seq - y.seq);
  if (wanted.length === 0) return [];
  const r = await gitOk(deps, repo, ['cat-file', '--batch'], { input: `${wanted.map((w) => w.sha).join('\n')}\n`, binary: true });
  const blobs = parseBatch(r.stdoutBuf ?? Buffer.alloc(0), wanted.length);
  return wanted.map((w, i) => ({ seq: w.seq, data: blobs[i]! }));
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

export async function readPresence(deps: GitDeps, repo: string, teamId: string, agentId: string): Promise<Buffer | null> {
  assertId('team', teamId); assertId('agent', agentId);
  const ref = await agentRef(deps, repo, teamId, agentId);
  return ref ? readFileAt(deps, repo, ref, PRESENCE_FILE) : null;
}
