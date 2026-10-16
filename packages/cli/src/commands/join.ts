import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { defaultMemberName, type InvitePreview, type ToolKind } from '@agentteams/shared';
import { saveCredential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { HubClient } from '../hubClient.js';
import { joinLocalTeam, LOCAL_TEAM_LABEL, localInviteMatches } from '../local/team.js';
import { githubTokenFor } from './hostedAuth.js';
import { hubLabel, hubUrlFrom } from '../paths.js';
import { checkTeamDir, detectGithubSlug, real, repoRoot } from '../repo.js';
import { printReport, runInstallers } from './install.js';

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
  const member = opts.as ?? defaultMemberName(deps.username);
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

export async function joinCommand(deps: CliDeps, code: string, opts: JoinOpts): Promise<void> {
  // A code for the team in this repo's local database joins locally; an explicit --hub always means a hub.
  if (opts.hub === undefined && (await localInviteMatches(deps, deps.cwd, code))) return joinLocally(deps, code, opts);
  const hubUrl = hubUrlFrom(opts.hub, deps.env);
  const client = new HubClient(hubUrl, { fetch: deps.fetch });
  const preview = await client.previewInvite(code);
  const githubToken = await githubTokenFor(deps, hubUrl, { trustHub: opts.trustHub }); // before cloning anything
  const repoPath = await resolveRepoPath(deps, preview, opts);
  await checkTeamDir(deps, repoPath);
  const identity = githubToken ? { githubToken } : { member: opts.as ?? defaultMemberName(deps.username) };
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
