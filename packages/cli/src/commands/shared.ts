import { realpath } from 'node:fs/promises';
import { ToolKind } from '@agentteams/shared';
import { loadCredentials, resolveCredentialForCwd, type Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { defaultBranch } from '../git.js';
import { repoRoot } from '../repo.js';
import { teamClientFor, type TeamClient } from '../teamClient.js';

export async function requireCredential(deps: CliDeps, agent?: ToolKind): Promise<Credential> {
  const cred = await resolveCredentialForCwd(deps, deps.cwd, agent);
  if (!cred) throw new Error(noCredentialsMessage(await repoRoot(deps, deps.cwd)));
  if (!agent) {
    const same = (await loadCredentials(deps)).filter((c) => c.repoPath === cred.repoPath);
    if (same.length > 1) {
      const tools = same.map((c) => c.tool).sort().join(', ');
      throw new Error(`multiple agentteams agents in this repo (${tools}); pass --agent <tool>`);
    }
  }
  return cred;
}

/** One team this repo has credentials for: a credential that can read it, and every local agent that belongs to it. */
export interface TeamAccess { cred: Credential; mine: string[] }

const teamKey = (c: Credential): string => (c.transport === 'git' && c.git ? `git:${c.git.teamId}` : `${c.transport ?? 'http'}:${c.hubUrl}:${c.teamName}`);

/**
 * Credentials for reading team state, which every agent of a team sees identically: no --agent needed.
 * Returns one entry per distinct team among this repo's credentials, ordered by tool name so the choice
 * is deterministic; `mine` lists the repo's local agents on that team. With --agent, just that credential.
 */
export async function readableTeams(deps: CliDeps, agent?: ToolKind): Promise<TeamAccess[]> {
  const first = await resolveCredentialForCwd(deps, deps.cwd, agent);
  if (!first) throw new Error(noCredentialsMessage(await repoRoot(deps, deps.cwd)));
  if (agent) return [{ cred: first, mine: [first.agentName] }];
  const same = (await loadCredentials(deps)).filter((c) => c.repoPath === first.repoPath)
    .sort((a, b) => a.tool.localeCompare(b.tool));
  const teams = new Map<string, TeamAccess>();
  for (const c of same) {
    const known = teams.get(teamKey(c));
    if (known) known.mine.push(c.agentName);
    else teams.set(teamKey(c), { cred: c, mine: [c.agentName] });
  }
  return [...teams.values()];
}

export const noCredentialsMessage = (repo: string): string =>
  `no agentteams credentials for ${repo}; run "agentteams create" or "agentteams join" first`;

export const clientFor = (deps: CliDeps, cred: Credential): TeamClient => teamClientFor(deps, cred);

export const dateOnly = (iso: string): string => iso.slice(0, 10);

export async function refExists(deps: CliDeps, cwd: string, ref: string): Promise<boolean> {
  return (await deps.exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })).code === 0;
}

/** Reject branch names that git would not accept or that could be read as an option (they come from the hub). */
export async function assertSafeBranch(deps: CliDeps, cwd: string, name: string, what = 'branch'): Promise<string> {
  const ok = name !== '' && !name.startsWith('-') && !name.includes('@{')
    && (await deps.exec('git', ['check-ref-format', '--branch', name], { cwd })).code === 0;
  if (!ok) throw new Error(`invalid ${what} name: ${JSON.stringify(name.slice(0, 80))}`);
  return name;
}

/** The team's default branch: the hub's recorded one when it exists in this clone, otherwise detected from git. */
export async function teamDefaultBranch(
  deps: CliDeps, client: TeamClient, cwd: string,
): Promise<{ branch: string; provider: string }> {
  const { team } = await client.status();
  const recorded = team.repo.defaultBranch;
  const branch = recorded && (await refExists(deps, cwd, recorded)) ? recorded : await defaultBranch(deps, cwd, team.repo.slug);
  return { branch: await assertSafeBranch(deps, cwd, branch, 'default branch'), provider: team.repo.provider };
}

/**
 * create/join never overwrite a credential: for a git team the private key in it is the agent's only identity.
 * Throws when `repoPath` already has an agent for `tool`, naming it and suggesting a free tool.
 */
export async function refuseExistingCredential(deps: Pick<CliDeps, 'env' | 'homedir'>, repoPath: string, tool: ToolKind): Promise<void> {
  const here = await realpath(repoPath).catch(() => repoPath);
  // An unreadable credentials location (not a directory) holds nothing to overwrite; saving reports it later.
  const all = await loadCredentials(deps).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOTDIR') return [];
    throw err;
  });
  const inRepo = all.filter((c) => c.repoPath === here);
  const hit = inRepo.find((c) => c.tool === tool);
  if (!hit) return;
  const free = ToolKind.options.find((t) => t !== 'other' && !inRepo.some((c) => c.tool === t)) ?? 'other';
  throw new Error(
    `this repo already has a ${tool} agent: ${hit.agentName} on team "${hit.teamName}" (${here}). ` +
    `To add another agent here, pass --agent <other tool> (e.g. --agent ${free}); credentials are never overwritten`);
}
