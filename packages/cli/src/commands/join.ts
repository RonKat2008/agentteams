import { rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { MemberName, type InvitePreview, type ToolKind } from '@agentteams/shared';
import { saveCredential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { decodeInvite, INVITE_PREFIX, InviteError } from '../git/invite.js';
import { findRemoteFor, repoNameOf } from '../git/remoteUrl.js';
import { assertGitTeamId, joinGitTeam } from '../git/setup.js';
import { HubClient } from '../hubClient.js';
import { joinLocalTeam, LOCAL_TEAM_LABEL, localInviteMatches } from '../local/team.js';
import { githubTokenFor } from './hostedAuth.js';
import { hubLabel, hubUrlFrom } from '../paths.js';
import { checkTeamDir, detectGithubSlug, isGitRepo, real, repoRoot, resolveMemberName } from '../repo.js';
import { printReport, runInstallers } from './install.js';
import { refuseExistingCredential } from './shared.js';

export interface JoinOpts { agent: ToolKind; as?: string; hub?: string; install: boolean; clone: boolean; dir?: string; trustHub?: boolean }

const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';

/** The slug comes from the hub team creator, so it is untrusted: validate before it reaches a path or URL. */
export function validSlug(slug: string | undefined): string {
  const parts = (slug ?? '').split('/');
  if (!slug || !SLUG_RE.test(slug) || parts.some((p) => p === '.' || p === '..') || slug.startsWith('-')) {
    throw new Error(`the team's repo slug is invalid ("${(slug ?? '').slice(0, 80)}"); ask the team creator to fix it`);
  }
  return slug;
}

/** Existing target: usable only when it is the top of a git repo whose origin is the team's repo. */
async function isCloneOf(deps: CliDeps, target: string, slug: string): Promise<boolean> {
  const top = await deps.exec('git', ['rev-parse', '--show-toplevel'], { cwd: target });
  if (top.code !== 0 || (await real(top.stdout.trim())) !== (await real(target))) return false;
  return (await detectGithubSlug(deps, target))?.toLowerCase() === slug.toLowerCase();
}

async function cloneRepo(deps: CliDeps, slug: string, target: string): Promise<void> {
  let res = await deps.exec('gh', ['repo', 'clone', slug, target]);
  if (res.code === 127) res = await deps.exec('git', ['clone', `https://github.com/${slug}.git`, target]);
  if (res.code !== 0) {
    const why = (firstLine(res.stderr) || firstLine(res.stdout) || 'unknown error').replace(/\/\/[^@/\s]+@/g, '//');
    throw new Error(`could not clone ${slug} (${why}). Ask the team creator to give you access to the GitHub repo, then re-run this command.`);
  }
}

/** Decide where the repo lives (cloning if needed) before the agent is created. */
async function resolveRepoPath(deps: CliDeps, preview: InvitePreview, opts: JoinOpts): Promise<string> {
  if (preview.repo.provider !== 'github') return repoRoot(deps, deps.cwd);
  const slug = validSlug(preview.repo.slug);
  const local = await detectGithubSlug(deps, deps.cwd);
  if (local?.toLowerCase() === slug.toLowerCase()) return repoRoot(deps, deps.cwd);
  if (!opts.clone) {
    const origin = local ?? ((await deps.exec('git', ['remote', 'get-url', 'origin'], { cwd: deps.cwd })).code === 0 ? 'not a GitHub repo' : 'none');
    deps.err(`warning: this team is linked to ${slug} but this directory's origin is ${origin}`);
    return repoRoot(deps, deps.cwd);
  }
  const target = opts.dir ? (isAbsolute(opts.dir) ? opts.dir : resolve(deps.cwd, opts.dir)) : join(deps.cwd, slug.split('/')[1]!);
  await checkTeamDir({ ...deps, err: () => {} }, target); // refuse home/root before cloning anything
  if (await stat(target).then(() => true, () => false)) {
    if (await isCloneOf(deps, target, slug)) return target;
    throw new Error(`${target} already exists and is not a clone of ${slug}; pass --dir <path>`);
  }
  deps.out(`Cloning ${slug} into ${target} (use --no-clone to use this directory instead)`);
  await cloneRepo(deps, slug, target);
  return target;
}

/** Adds another agent to the team in this repo's local database (no hub, no clone). */
async function joinLocally(deps: CliDeps, code: string, opts: JoinOpts): Promise<void> {
  const repoPath = await repoRoot(deps, deps.cwd);
  await checkTeamDir(deps, repoPath);
  await refuseExistingCredential(deps, repoPath, opts.agent);
  const member = opts.as ?? await resolveMemberName(deps, repoPath);
  const res = await joinLocalTeam(deps, repoPath, { inviteCode: code, tool: opts.agent, member });
  const cred = {
    repoPath, tool: opts.agent, hubUrl: '', teamName: res.teamName, agentName: res.agentName,
    apiKey: res.apiKey, createdAt: new Date().toISOString(), transport: 'local' as const,
  };
  await saveCredential(deps, cred);
  deps.out(`Joined team "${res.teamName}" as ${res.agentName} (local). Repo: ${repoPath}`);
  deps.out(LOCAL_TEAM_LABEL);
  if (opts.install) printReport(deps, await runInstallers(deps, cred));
}

/** Without --hub and AGENTTEAMS_HUB, a code that is neither a git invite nor this repo's local code is an error. */
export const UNKNOWN_CODE_HELP =
  'this invite code is not for a team in this repo. There are three kinds of codes:\n' +
  '  at1-...               a team shared through a git repo: agentteams join at1-...\n' +
  '  abcd-efgh-jkmn-pqrs   a team on this computer: run the join inside that team\'s repo\n' +
  '  abcd-efgh-jkmn-pqrs   a team on a hub server: agentteams join <code> --hub <url>';

/** The transports an invite can carry (no plain http, so an https remote cannot redirect to it). */
const CLONE_PROTOCOLS = ['file', 'https', 'ssh'];

/** GIT_ALLOW_PROTOCOL for the clone: ours, narrowed further by a stricter setting of the user's. */
export function cloneProtocols(env: NodeJS.ProcessEnv): string {
  const user = env.GIT_ALLOW_PROTOCOL;
  if (user === undefined) return CLONE_PROTOCOLS.join(':');
  const allowed = new Set(user.split(':').map((p) => p.trim()).filter(Boolean));
  return CLONE_PROTOCOLS.filter((p) => allowed.has(p)).join(':');
}

/** Clones the team's repo; the URL comes from an invite, so only safe transports and `--` before it. */
async function cloneUrl(deps: CliDeps, url: string, target: string): Promise<void> {
  deps.out(`Cloning ${url} into ${target} (use --no-clone to use this directory instead)`);
  const res = await deps.exec('git', ['clone', '--quiet', '--', url, target], { env: { GIT_ALLOW_PROTOCOL: cloneProtocols(deps.env) } });
  if (res.code !== 0) {
    const why = (firstLine(res.stderr) || firstLine(res.stdout) || 'unknown error').replace(/\/\/[^@/\s]+@/g, '//');
    throw new Error(`could not clone ${url} (${why}). Ask the team creator to give you access to the repo, then re-run this command.`);
  }
}

/** Where a git team's repo lives, which remote (name, or the invite's URL) it syncs through, and whether we cloned it. */
interface GitRepo { repoPath: string; remote: string; cloned?: boolean }

async function gitRepoFor(deps: CliDeps, url: string, opts: JoinOpts): Promise<GitRepo> {
  if (await isGitRepo(deps, deps.cwd)) {
    const repoPath = await repoRoot(deps, deps.cwd);
    const remote = await findRemoteFor(deps, repoPath, url);
    if (remote) return { repoPath, remote };
    if (!opts.clone) {
      deps.err(`warning: this repo has no remote for ${url}; the team syncs with that URL directly`);
      return { repoPath, remote: url };
    }
  } else if (!opts.clone) {
    throw new Error('--no-clone needs a git repository here (run "git init", or clone the team repo first)');
  }
  const name = repoNameOf(url);
  if (!opts.dir && !name) throw new Error(`cannot tell the repo's name from ${url}; pass --dir <path>`);
  const target = opts.dir ? (isAbsolute(opts.dir) ? opts.dir : resolve(deps.cwd, opts.dir)) : join(deps.cwd, name!);
  await checkTeamDir({ ...deps, err: () => {} }, target); // refuse home/root before cloning anything
  if (await stat(target).then(() => true, () => false)) {
    const top = await deps.exec('git', ['rev-parse', '--show-toplevel'], { cwd: target });
    const remote = top.code === 0 && (await real(top.stdout.trim())) === (await real(target)) ? await findRemoteFor(deps, target, url) : null;
    if (remote) return { repoPath: target, remote };
    throw new Error(`${target} already exists and is not a clone of ${url}; pass --dir <path>`);
  }
  await cloneUrl(deps, url, target);
  return { repoPath: await real(target), remote: 'origin', cloned: true };
}

/** `join at1-...`: a team shared through a git repo (no hub, no GitHub token). */
async function joinGit(deps: CliDeps, code: string, opts: JoinOpts): Promise<void> {
  if (opts.hub !== undefined) throw new Error('at1- codes are for teams shared through git; drop --hub');
  let invite;
  try {
    invite = decodeInvite(code);
  } catch (e) {
    if (e instanceof InviteError) throw new Error(`invalid invite code: ${e.message}`);
    throw e;
  }
  // Everything that can be checked without touching the disk, before any clone.
  assertGitTeamId(invite.teamId);
  const member = MemberName.parse(opts.as ?? await resolveMemberName(deps, deps.cwd));
  const { repoPath, remote, cloned } = await gitRepoFor(deps, invite.remote, opts);
  let res;
  try {
    await checkTeamDir(deps, repoPath);
    await refuseExistingCredential(deps, repoPath, opts.agent);
    res = await joinGitTeam(deps, {
      repoPath, remote, url: invite.remote, teamId: invite.teamId, teamKey: invite.key, creator: invite.creator, tool: opts.agent, member,
    });
    await saveCredential(deps, res.cred);
  } catch (e) {
    // A clone this call made holds nothing else: remove it, so a retry starts clean.
    if (cloned) await rm(repoPath, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  deps.out(`Joined team "${res.teamName}" as ${res.cred.agentName} (shared through ${invite.remote}). Repo: ${repoPath}`);
  if (opts.install) printReport(deps, await runInstallers(deps, res.cred));
}

export async function joinCommand(deps: CliDeps, code: string, opts: JoinOpts): Promise<void> {
  // base32 is case-insensitive: route and decode the lower-case form.
  if (code.trim().toLowerCase().startsWith(INVITE_PREFIX)) return joinGit(deps, code.trim().toLowerCase(), opts);
  // A code for the team in this repo's local database joins locally; an explicit --hub always means a hub.
  if (opts.hub === undefined && (await localInviteMatches(deps, deps.cwd, code))) return joinLocally(deps, code, opts);
  // No silent fallback to the public hub: a hub must be named (--hub or AGENTTEAMS_HUB).
  if (opts.hub === undefined && !deps.env.AGENTTEAMS_HUB) throw new Error(UNKNOWN_CODE_HELP);
  const hubUrl = hubUrlFrom(opts.hub, deps.env);
  const client = new HubClient(hubUrl, { fetch: deps.fetch });
  const preview = await client.previewInvite(code);
  const githubToken = await githubTokenFor(deps, hubUrl, { trustHub: opts.trustHub }); // before cloning anything
  const repoPath = await resolveRepoPath(deps, preview, opts);
  await checkTeamDir(deps, repoPath);
  await refuseExistingCredential(deps, repoPath, opts.agent);
  const identity = githubToken ? { githubToken } : { member: opts.as ?? await resolveMemberName(deps, repoPath) };
  const res = await client.joinTeam({ inviteCode: code, tool: opts.agent, ...identity });
  const cred = {
    repoPath, tool: opts.agent, hubUrl, teamName: res.teamName, agentName: res.agentName,
    apiKey: res.apiKey, createdAt: new Date().toISOString(),
  };
  await saveCredential(deps, cred);
  deps.out(`Joined team "${res.teamName}" as ${res.agentName}. Repo: ${repoPath}`);
  deps.out(`Hub: ${hubLabel(hubUrl)}`);
  if (opts.install) printReport(deps, await runInstallers(deps, cred));
}
