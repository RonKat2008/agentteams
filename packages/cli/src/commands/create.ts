import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultMemberName, type RepoLink, type ToolKind } from '@agentteams/shared';
import { saveCredential, type Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { defaultBranch } from '../git.js';
import { HubClient } from '../hubClient.js';
import { githubTokenFor } from './hostedAuth.js';
import { hubLabel, hubUrlFrom } from '../paths.js';
import { checkTeamDir, detectGithubSlug, repoRoot } from '../repo.js';
import { printReport, runInstallers } from './install.js';
import { dateOnly } from './shared.js';

export interface CreateOpts {
  agent: ToolKind; as?: string; hub?: string; repo?: string; local?: boolean; install: boolean;
  newRepo?: boolean; trustHub?: boolean; visibility?: 'private' | 'public'; owner?: string;
}

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';
const msgOf = (r: { stderr: string; stdout: string }): string => firstLine(r.stderr) || firstLine(r.stdout) || 'unknown error';

async function warnIfNoAccess(deps: CliDeps, slug: string, cwd: string): Promise<void> {
  const res = await deps.exec('gh', ['repo', 'view', slug, '--json', 'nameWithOwner'], { cwd });
  if (res.code === 127) return;
  if (res.code !== 0) deps.err(`warning: could not verify access to ${slug} with gh (${firstLine(res.stderr)})`);
}

async function resolveRepoLink(deps: CliDeps, opts: CreateOpts, repoPath: string): Promise<RepoLink> {
  const slug = opts.repo ?? (opts.local ? null : await detectGithubSlug(deps, deps.cwd));
  if (slug) {
    await warnIfNoAccess(deps, slug, repoPath);
    return { provider: 'github', slug, defaultBranch: await defaultBranch(deps, repoPath, slug) };
  }
  if (!opts.local) deps.err('no GitHub origin found; creating a local-only team (use --repo owner/name to link one)');
  return { provider: 'local', defaultBranch: await defaultBranch(deps, repoPath) };
}

async function gitOrThrow(deps: CliDeps, cwd: string, args: string[]): Promise<string> {
  const r = await deps.exec('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${msgOf(r)}`);
  return r.stdout;
}

/** Spec §3A steps 1-3: verify gh, create the local repo with a first commit, create and push the GitHub repo. */
function validateNewRepoArgs(name: string, owner?: string): void {
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

async function registerTeam(
  deps: CliDeps, name: string, opts: CreateOpts, repoPath: string, repo: RepoLink, githubToken: string | undefined,
): Promise<Credential> {
  const hubUrl = hubUrlFrom(opts.hub, deps.env);
  const identity = githubToken ? { githubToken } : { member: opts.as ?? defaultMemberName(deps.username) };
  const res = await new HubClient(hubUrl, { fetch: deps.fetch }).createTeam({ name, tool: opts.agent, repo, ...identity });
  const cred = {
    repoPath, tool: opts.agent, hubUrl, teamName: res.teamName, agentName: res.agentName,
    apiKey: res.apiKey, createdAt: new Date().toISOString(),
  };
  deps.out(`Created team "${res.teamName}". You are ${res.agentName} (orchestrator).`);
  deps.out(`Invite code: ${res.inviteCode} (expires ${dateOnly(res.inviteExpiresAt)})`);
  deps.out(`Teammates join with: agentteams join ${res.inviteCode} --hub ${hubUrl}`);
  deps.out(`Hub: ${hubLabel(hubUrl)}`);
  await saveCredential(deps, cred);
  return cred;
}

export async function createCommand(deps: CliDeps, name: string, opts: CreateOpts): Promise<void> {
  // A fresh --new-repo folder is made below, so the "not a git repo" warning does not apply to cwd.
  await checkTeamDir(opts.newRepo ? { ...deps, err: () => {} } : deps, deps.cwd);
  // Before any side effect (repo creation); hosted hubs need the gh identity once.
  const githubToken = await githubTokenFor(deps, hubUrlFrom(opts.hub, deps.env), { trustHub: opts.trustHub });
  if (!opts.newRepo) {
    const repoPath = await repoRoot(deps, deps.cwd);
    const repo = await resolveRepoLink(deps, opts, repoPath);
    const cred = await registerTeam(deps, name, opts, repoPath, repo, githubToken);
    if (opts.install) printReport(deps, await runInstallers(deps, cred));
    return;
  }
  const dir = await scaffoldNewRepo(deps, name, opts);
  let created = opts.owner ? `${opts.owner}/${name}` : name;
  let stage = 'looking up the new repo';
  try {
    const repo = await newRepoLink(deps, dir);
    created = repo.slug ?? created;
    stage = 'registering the team';
    const cred = await registerTeam(deps, name, opts, dir, repo, githubToken);
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
}
