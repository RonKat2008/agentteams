/**
 * Git remote URLs for git teams: which remote a repo shares its team through, the URL that goes into an invite
 * (credentials stripped), and matching an invite's URL against a clone's remotes.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { CliDeps } from '../deps.js';
import { isValidRemote } from './invite.js';

type Deps = Pick<CliDeps, 'exec'>;

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
const SCP_LIKE_RE = /^([^/@:\s]+@)?([^/:\s]+):(?!\/\/)(.+)$/;

/**
 * Removes credentials from a remote URL: all userinfo of http(s) URLs (a token often sits in the user part), and
 * the password of other URLs (`ssh://git:secret@host` becomes `ssh://git@host`). scp-like and path remotes have none.
 */
export function stripCredentials(url: string): string {
  const m = SCHEME_RE.exec(url);
  if (!m) return url;
  const scheme = m[1]!.toLowerCase();
  const rest = url.slice(m[0].length);
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '' : rest.slice(slash);
  const at = authority.lastIndexOf('@');
  if (at < 0) return url;
  const user = authority.slice(0, at).split(':')[0]!;
  const host = authority.slice(at + 1);
  const keepUser = scheme !== 'http' && scheme !== 'https' && user !== '';
  return `${m[0]}${keepUser ? `${user}@` : ''}${host}${path}`;
}

/** A comparable form: host (lower case) and path without user, scheme, port of ssh, trailing slash or `.git`. */
export async function normalizeRemote(url: string, base?: string): Promise<string> {
  let u = stripCredentials(url.trim());
  const scheme = SCHEME_RE.exec(u);
  if (scheme && scheme[1]!.toLowerCase() === 'file') u = decodeURIComponent(u.slice('file://'.length));
  else if (scheme) {
    const rest = u.slice(scheme[0].length).replace(/^[^/@]*@/, '');
    const slash = rest.indexOf('/');
    const host = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase().replace(/:\d+$/, '');
    return `${host}/${trimRepoPath(slash < 0 ? '' : rest.slice(slash + 1))}`;
  } else {
    const scp = SCP_LIKE_RE.exec(u);
    if (scp && !isAbsolute(u)) return `${scp[2]!.toLowerCase()}/${trimRepoPath(scp[3]!)}`;
  }
  // A local path: resolve it (and symlinks) so two spellings of the same directory match.
  const abs = isAbsolute(u) ? u : resolve(base ?? process.cwd(), u);
  const real = await realpath(abs).catch(() => abs);
  return `file:${real.replace(/\/+$/, '')}`;
}

const trimRepoPath = (p: string): string => p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();

/** The repository's directory name a fresh clone gets (`./<name>`), or null when the URL has none usable. */
export function repoNameOf(url: string): string | null {
  const path = stripCredentials(url).replace(/[?#].*$/, '').replace(/\/+$/, '');
  const last = path.split(/[/:]/).pop() ?? '';
  const name = last.replace(/\.git$/, '');
  return /^[A-Za-z0-9._-]+$/.test(name) && !/^[-.]/.test(name) ? name : null;
}

/** The repo's remote names (`git remote`). */
export async function remoteNames(deps: Deps, repo: string): Promise<string[]> {
  const r = await deps.exec('git', ['remote'], { cwd: repo });
  return r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/** The fetch URL of a remote (after url.insteadOf), or null. */
export async function remoteFetchUrl(deps: Deps, repo: string, name: string): Promise<string | null> {
  const r = await deps.exec('git', ['remote', 'get-url', '--', name], { cwd: repo });
  const url = r.stdout.trim();
  return r.code === 0 && url ? url : null;
}

/**
 * The remote a new team is shared through: `--remote <name>` (must exist), else `origin`, else the only remote.
 * Null when the repo has no remote at all.
 */
export async function pickRemote(deps: Deps, repo: string, requested?: string): Promise<string | null> {
  const names = await remoteNames(deps, repo);
  if (requested !== undefined) {
    if (!names.includes(requested)) throw new Error(`this repo has no git remote named "${requested}" (remotes: ${names.join(', ') || 'none'})`);
    return requested;
  }
  if (names.includes('origin')) return 'origin';
  if (names.length === 1) return names[0]!;
  if (names.length === 0) return null;
  throw new Error(`this repo has several git remotes and none is "origin"; pass --remote <name> (one of: ${names.join(', ')})`);
}

/**
 * The URL that goes into an invite: credentials stripped, a relative path made absolute against the repo.
 * Throws when the result cannot be carried by an invite (e.g. http:// or a `user@host:path` other than git@).
 */
export function shareableUrl(url: string, repo: string): string {
  let u = stripCredentials(url.trim());
  if (!SCHEME_RE.exec(u) && !SCP_LIKE_RE.exec(u) && !isAbsolute(u)) u = resolve(repo, u);
  if (!isValidRemote(u)) {
    throw new Error(
      `the remote ${u} cannot be shared in an invite code (use an https://, ssh://, git@host:path or absolute-path remote), ` +
      'or pass --this-computer for a team on this computer only');
  }
  return u;
}

/** The name of a remote of `repo` whose fetch URL is the same repository as `url`, or null. */
export async function findRemoteFor(deps: Deps, repo: string, url: string): Promise<string | null> {
  const want = await normalizeRemote(url, repo);
  const names = await remoteNames(deps, repo);
  for (const name of [...names.filter((n) => n === 'origin'), ...names.filter((n) => n !== 'origin')]) {
    const have = await remoteFetchUrl(deps, repo, name);
    if (have && (await normalizeRemote(have, repo)) === want) return name;
  }
  return null;
}
