import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { defaultMemberName, type InvitePreview, type ToolKind } from '@agentteams/shared';
import { saveCredential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { HubClient } from '../hubClient.js';
import { hubUrlFrom } from '../paths.js';
import { checkTeamDir, detectGithubSlug, real, repoRoot } from '../repo.js';
import { printReport, runInstallers } from './install.js';

export interface JoinOpts { agent: ToolKind; as?: string; hub?: string; install: boolean; clone: boolean; dir?: string }

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
    deps.err(`warning: this team is linked to ${slug} but this directory's origin is ${local ?? 'none'}`);
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

export async function joinCommand(deps: CliDeps, code: string, opts: JoinOpts): Promise<void> {
  const hubUrl = hubUrlFrom(opts.hub, deps.env);
  const client = new HubClient(hubUrl, { fetch: deps.fetch });
  const preview = await client.previewInvite(code);
  const repoPath = await resolveRepoPath(deps, preview, opts);
  await checkTeamDir(deps, repoPath);
  const member = opts.as ?? defaultMemberName(deps.username);
  const res = await client.joinTeam({ inviteCode: code, member, tool: opts.agent });
  const cred = {
    repoPath, tool: opts.agent, hubUrl, teamName: res.teamName, agentName: res.agentName,
    apiKey: res.apiKey, createdAt: new Date().toISOString(),
  };
  await saveCredential(deps, cred);
  deps.out(`Joined team "${res.teamName}" as ${res.agentName}. Repo: ${repoPath}`);
  if (opts.install) printReport(deps, await runInstallers(deps, cred));
}
