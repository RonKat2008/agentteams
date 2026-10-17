import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultMemberName, MemberName, type RepoLink, type ToolKind } from '@agentteams/shared';
import { saveCredential, type Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { defaultBranch } from '../git.js';
import { pickRemote } from '../git/remoteUrl.js';
import { createGitTeam, hasGitTeam, INVITE_WARNING } from '../git/setup.js';
import { HubClient } from '../hubClient.js';
import { createLocalTeam, LOCAL_TEAM_LABEL } from '../local/team.js';
import { githubTokenFor } from './hostedAuth.js';
import { hubLabel, hubUrlFrom } from '../paths.js';
import { checkTeamDir, detectGithubSlug, isGitRepo, repoRoot } from '../repo.js';
import { printReport, runInstallers } from './install.js';
import { dateOnly, refuseExistingCredential } from './shared.js';

/** `inviteExpiresAt` is '' for git teams (their code does not expire); `remoteUrl` is set only for them. */
export interface CreateResult { teamName: string; inviteCode: string; inviteExpiresAt: string; hubUrl: string; remoteUrl?: string }

export interface CreateOpts {
  agent: ToolKind; as?: string; hub?: string; repo?: string; local?: boolean; install: boolean;
  newRepo?: boolean; trustHub?: boolean; visibility?: 'private' | 'public'; owner?: string;
  /** A team for agents on this computer only, even when the repo has a git remote. */
  thisComputer?: boolean;
  /** The git remote a git team is shared through (default: origin). */
  remote?: string;
}

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';
const msgOf = (r: { stderr: string; stdout: string }): string => firstLine(r.stderr) || firstLine(r.stdout) || 'unknown error';

async function warnIfNoAccess(deps: CliDeps, slug: string, cwd: string): Promise<void> {
  const res = await deps.exec('gh', ['repo', 'view', slug, '--json', 'nameWithOwner'], { cwd });
  if (res.code === 127) return;
  if (res.code !== 0) deps.err(`warning: could not verify access to ${slug} with gh (${firstLine(res.stderr)})`);
}

async function resolveRepoLink(deps: CliDeps, opts: CreateOpts, repoPath: string, quiet = false): Promise<RepoLink> {
  const slug = opts.repo ?? (opts.local ? null : await detectGithubSlug(deps, deps.cwd));
  if (slug) {
    await warnIfNoAccess(deps, slug, repoPath);
    return { provider: 'github', slug, defaultBranch: await defaultBranch(deps, repoPath, slug) };
  }
  if (!opts.local && !quiet) deps.err('no GitHub origin found; creating a local-only team (use --repo owner/name to link one)');
  return { provider: 'local', defaultBranch: await defaultBranch(deps, repoPath) };
}

async function gitOrThrow(deps: CliDeps, cwd: string, args: string[]): Promise<string> {
  const r = await deps.exec('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${msgOf(r)}`);
  return r.stdout;
}

/** The exact command teammates run to join (printed by create and by the guided menu); local teams have no hub URL. */
export const teammateJoinCommand = (inviteCode: string, hubUrl: string): string =>
  hubUrl ? `agentteams join ${inviteCode} --hub ${hubUrl}` : `agentteams join ${inviteCode}`;

/** No --hub flag and no AGENTTEAMS_HUB: the team is stored in this repo (a local or a git team), not on a hub. */
export const isLocalCreate = (opts: Pick<CreateOpts, 'hub'>, env: NodeJS.ProcessEnv): boolean =>
  opts.hub === undefined && !env.AGENTTEAMS_HUB;

export type CreateKind = 'hub' | 'local' | 'git';

/**
 * Which kind of team `create` makes, in order: --hub / AGENTTEAMS_HUB -> a hub; --this-computer or --local -> this
 * computer only; --new-repo or a repo with a git remote -> a git team shared through the remote; else local.
 * Returns the remote name for a git team.
 */
export async function createKind(deps: CliDeps, opts: CreateOpts, repoPath: string): Promise<{ kind: CreateKind; remote?: string }> {
  if (!isLocalCreate(opts, deps.env)) return { kind: 'hub' };
  if (opts.thisComputer || opts.local) return { kind: 'local' };
  const remote = await pickRemote(deps, repoPath, opts.remote);
  return remote ? { kind: 'git', remote } : { kind: 'local' };
}

/** Spec §3A steps 1-3: verify gh, create the local repo with a first commit, create and push the GitHub repo. */
export function validateNewRepoArgs(name: string, owner?: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || /^[-.]/.test(name)) {
    throw new Error(`invalid repo name "${name}": use letters, digits, '.', '_' or '-'`);
  }
  if (owner !== undefined && (!/^[A-Za-z0-9-]+$/.test(owner) || owner.startsWith('-'))) {
    throw new Error(`invalid owner "${owner}": use letters, digits or '-'`);
  }
}

async function requireGitIdentity(deps: CliDeps): Promise<void> {
  for (const key of ['user.name', 'user.email']) {
    const r = await deps.exec('git', ['config', key], { cwd: deps.cwd });
    if (r.code !== 0 || !r.stdout.trim()) {
      throw new Error('git identity not set; run: git config --global user.name "Your Name" && git config --global user.email you@example.com');
    }
  }
}

async function scaffoldNewRepo(deps: CliDeps, name: string, opts: CreateOpts): Promise<string> {
  validateNewRepoArgs(name, opts.owner);
  const auth = await deps.exec('gh', ['auth', 'status']);
  if (auth.code === 127) throw new Error('gh (GitHub CLI) is required for --new-repo');
  if (auth.code !== 0) throw new Error('gh is not authenticated; run: gh auth login');
  await requireGitIdentity(deps);
  const dir = join(deps.cwd, name);
  const existing = await readdir(dir).catch(() => null);
  if (existing && existing.length > 0) throw new Error(`${dir} already exists and is not empty`);
  await mkdir(dir, { recursive: true });
  await gitOrThrow(deps, dir, ['init', '-b', 'main']);
  await writeFile(join(dir, 'README.md'), `# ${name}\n`);
  await gitOrThrow(deps, dir, ['add', 'README.md']);
  await gitOrThrow(deps, dir, ['-c', 'user.useConfigOnly=true', 'commit', '-m', 'chore: initial commit']);
  const full = opts.owner ? `${opts.owner}/${name}` : name;
  const created = await deps.exec(
    'gh', ['repo', 'create', full, opts.visibility === 'public' ? '--public' : '--private', '--source', dir, '--push'], { cwd: dir });
  if (created.code !== 0) throw new Error(`gh repo create failed: ${msgOf(created)} (local folder ${dir} was kept)`);
  return dir;
}

async function newRepoLink(deps: CliDeps, dir: string): Promise<RepoLink> {
  const view = await deps.exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: dir });
  const slug = view.stdout.trim();
  if (view.code !== 0 || !slug) throw new Error(`could not read the new repo's name from gh: ${msgOf(view)} (local folder ${dir} was kept)`);
  return { provider: 'github', slug, defaultBranch: 'main' };
}

/** Commit and push the instruction files the installers wrote; failures only warn. */
async function commitInstructions(deps: CliDeps, dir: string): Promise<void> {
  const st = await deps.exec('git', ['status', '--porcelain', '--', 'CLAUDE.md', 'AGENTS.md'], { cwd: dir });
  const files = st.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
  if (st.code !== 0 || files.length === 0) return;
  const steps: string[][] = [['add', '--', ...files], ['commit', '-m', 'chore: add agentteams instructions', '--', ...files]];
  for (const args of steps) {
    const r = await deps.exec('git', ['-c', 'user.useConfigOnly=true', ...args], { cwd: dir });
    if (r.code !== 0) { deps.err(`warning: could not commit agentteams instructions (${msgOf(r)})`); return; }
  }
  const push = await deps.exec('git', ['push'], { cwd: dir });
  if (push.code !== 0) deps.err(`warning: could not push the instructions commit (${msgOf(push)})`);
}

async function registerLocalTeam(
  deps: CliDeps, name: string, opts: CreateOpts, repoPath: string, repo: RepoLink,
): Promise<{ cred: Credential; result: CreateResult }> {
  if (await hasGitTeam(deps, repoPath)) {
    throw new Error('this repo already has a git team; a repo holds one git team (use another clone for a team on this computer only)');
  }
  const member = opts.as ?? defaultMemberName(deps.username);
  const res = await createLocalTeam(deps, repoPath, { name, tool: opts.agent, repo, member });
  const cred: Credential = {
    repoPath, tool: opts.agent, hubUrl: '', teamName: res.teamName, agentName: res.agentName,
    apiKey: res.apiKey, createdAt: new Date().toISOString(), transport: 'local',
  };
  deps.out(`Created team "${res.teamName}". You are ${res.agentName} (orchestrator).`);
  deps.out(`Invite code: ${res.inviteCode} (expires ${dateOnly(res.inviteExpiresAt)})`);
  deps.out(`Teammates join with: ${teammateJoinCommand(res.inviteCode, '')}`);
  deps.out(LOCAL_TEAM_LABEL);
  await saveCredential(deps, cred);
  return { cred, result: { teamName: res.teamName, inviteCode: res.inviteCode, inviteExpiresAt: res.inviteExpiresAt, hubUrl: '' } };
}

/** A git team shared through `remote`: no hub and no GitHub token; the push needs the user's normal git access. */
async function registerGitTeam(
  deps: CliDeps, name: string, opts: CreateOpts, repoPath: string, repo: RepoLink, remote: string,
): Promise<{ cred: Credential; result: CreateResult }> {
  const member = MemberName.parse(opts.as ?? defaultMemberName(deps.username));
  const res = await createGitTeam(deps, { repoPath, remote, name, tool: opts.agent, member, repo });
  await saveCredential(deps, res.cred);
  deps.out(`Created team "${name}" (shared through ${res.remoteUrl}). You are ${res.cred.agentName} (orchestrator).`);
  deps.out(`Teammates join with: ${teammateJoinCommand(res.inviteCode, '')}`);
  deps.out(INVITE_WARNING);
  return { cred: res.cred, result: { teamName: name, inviteCode: res.inviteCode, inviteExpiresAt: '', hubUrl: '', remoteUrl: res.remoteUrl } };
}

async function registerTeam(
  deps: CliDeps, name: string, opts: CreateOpts, repoPath: string, repo: RepoLink, githubToken: string | undefined,
): Promise<{ cred: Credential; result: CreateResult }> {
  if (isLocalCreate(opts, deps.env)) {
    const { kind, remote } = await createKind(deps, opts, repoPath);
    if (kind === 'git') return registerGitTeam(deps, name, opts, repoPath, repo, remote!);
    return registerLocalTeam(deps, name, opts, repoPath, repo);
  }
  const hubUrl = hubUrlFrom(opts.hub, deps.env);
  const identity = githubToken ? { githubToken } : { member: opts.as ?? defaultMemberName(deps.username) };
  const res = await new HubClient(hubUrl, { fetch: deps.fetch }).createTeam({ name, tool: opts.agent, repo, ...identity });
  const cred = {
    repoPath, tool: opts.agent, hubUrl, teamName: res.teamName, agentName: res.agentName,
    apiKey: res.apiKey, createdAt: new Date().toISOString(),
  };
  deps.out(`Created team "${res.teamName}". You are ${res.agentName} (orchestrator).`);
  deps.out(`Invite code: ${res.inviteCode} (expires ${dateOnly(res.inviteExpiresAt)})`);
  deps.out(`Teammates join with: ${teammateJoinCommand(res.inviteCode, hubUrl)}`);
  deps.out(`Hub: ${hubLabel(hubUrl)}`);
  await saveCredential(deps, cred);
  return { cred, result: { teamName: res.teamName, inviteCode: res.inviteCode, inviteExpiresAt: res.inviteExpiresAt, hubUrl } };
}

export async function createCommand(deps: CliDeps, name: string, opts: CreateOpts): Promise<CreateResult> {
  // A fresh --new-repo folder is made below, so the "not a git repo" warning does not apply to cwd.
  const local = isLocalCreate(opts, deps.env);
  if (opts.thisComputer && !local) throw new Error('--this-computer makes a team without a hub; drop --hub (and AGENTTEAMS_HUB)');
  if (opts.thisComputer && opts.newRepo) throw new Error('--this-computer and --new-repo do not go together: a new GitHub repo is for sharing the team');
  if (opts.remote !== undefined && (opts.thisComputer || opts.local || !local)) {
    throw new Error('--remote is for teams shared through git; drop --hub, --local and --this-computer');
  }
  await checkTeamDir(opts.newRepo || local ? { ...deps, err: () => {} } : deps, deps.cwd);
  if (local && !opts.newRepo && !(await isGitRepo(deps, deps.cwd))) {
    throw new Error('a local team lives in a git repository; run "git init" here first (or pass --hub <url> to use a hub)');
  }
  if (!opts.newRepo) await refuseExistingCredential(deps, await repoRoot(deps, deps.cwd), opts.agent);
  // Before any side effect (repo creation); hosted hubs need the gh identity once. Local teams have no hub.
  const githubToken = local ? undefined : await githubTokenFor(deps, hubUrlFrom(opts.hub, deps.env), { trustHub: opts.trustHub });
  if (!opts.newRepo) {
    const repoPath = await repoRoot(deps, deps.cwd);
    const repo = await resolveRepoLink(deps, opts, repoPath, local);
    const { cred, result } = await registerTeam(deps, name, opts, repoPath, repo, githubToken);
    if (opts.install) printReport(deps, await runInstallers(deps, cred));
    return result;
  }
  const dir = await scaffoldNewRepo(deps, name, opts);
  let created = opts.owner ? `${opts.owner}/${name}` : name;
  let stage = 'looking up the new repo';
  let result: CreateResult;
  try {
    const repo = await newRepoLink(deps, dir);
    created = repo.slug ?? created;
    stage = 'registering the team';
    const registered = await registerTeam(deps, name, opts, dir, repo, githubToken);
    const cred = registered.cred;
    result = registered.result;
    if (opts.install) {
      printReport(deps, await runInstallers(deps, cred));
      await commitInstructions(deps, dir);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `GitHub repo ${created} was created and the local folder ${dir} was kept, but ${stage} failed: ${msg}. ` +
      `To finish, run: cd ${dir} && agentteams create ${name}`);
  }
  deps.out(`Next: cd ${name}`);
  return result;
}
