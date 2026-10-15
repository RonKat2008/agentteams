import type { RepoLink, ToolKind } from '@agentteams/shared';
import { saveCredential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { HubClient } from '../hubClient.js';
import { hubUrlFrom } from '../paths.js';
import { checkTeamDir, defaultMemberName, detectGithubSlug, repoRoot } from '../repo.js';
import { printReport, runInstallers } from './install.js';
import { dateOnly } from './shared.js';

export interface CreateOpts { agent: ToolKind; as?: string; hub?: string; repo?: string; local?: boolean; install: boolean }

async function resolveRepoLink(deps: CliDeps, opts: CreateOpts): Promise<RepoLink> {
  if (opts.repo) return { provider: 'github', slug: opts.repo, defaultBranch: 'main' };
  if (opts.local) return { provider: 'local', defaultBranch: 'main' };
  const slug = await detectGithubSlug(deps, deps.cwd);
  if (slug) return { provider: 'github', slug, defaultBranch: 'main' };
  deps.err('no GitHub origin found; creating a local-only team (use --repo owner/name to link one)');
  return { provider: 'local', defaultBranch: 'main' };
}

export async function createCommand(deps: CliDeps, name: string, opts: CreateOpts): Promise<void> {
  await checkTeamDir(deps, deps.cwd);
  const repoPath = await repoRoot(deps, deps.cwd);
  const repo = await resolveRepoLink(deps, opts);
  const hubUrl = hubUrlFrom(opts.hub, deps.env);
  const member = opts.as ?? defaultMemberName(deps.username);
  const res = await new HubClient(hubUrl, { fetch: deps.fetch }).createTeam({ name, member, tool: opts.agent, repo });
  const cred = {
    repoPath, tool: opts.agent, hubUrl, teamName: res.teamName, agentName: res.agentName,
    apiKey: res.apiKey, createdAt: new Date().toISOString(),
  };
  deps.out(`Created team "${res.teamName}". You are ${res.agentName} (orchestrator).`);
  deps.out(`Invite code: ${res.inviteCode} (expires ${dateOnly(res.inviteExpiresAt)})`);
  deps.out(`Teammates join with: agentteams join ${res.inviteCode} --hub ${hubUrl}`);
  await saveCredential(deps, cred);
  if (opts.install) printReport(deps, await runInstallers(deps, cred));
}
