import type { ToolKind } from '@agentteams/shared';
import { loadCredentials, resolveCredentialForCwd, type Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { HubClient } from '../hubClient.js';
import { defaultBranch } from '../git.js';
import { repoRoot } from '../repo.js';

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

export const noCredentialsMessage = (repo: string): string =>
  `no agentteams credentials for ${repo}; run "agentteams create" or "agentteams join" first`;

export const clientFor = (deps: CliDeps, cred: Credential): HubClient =>
  new HubClient(cred.hubUrl, { apiKey: cred.apiKey, fetch: deps.fetch });

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
  deps: CliDeps, client: HubClient, cwd: string,
): Promise<{ branch: string; provider: string }> {
  const { team } = await client.status();
  const recorded = team.repo.defaultBranch;
  const branch = recorded && (await refExists(deps, cwd, recorded)) ? recorded : await defaultBranch(deps, cwd, team.repo.slug);
  return { branch: await assertSafeBranch(deps, cwd, branch, 'default branch'), provider: team.repo.provider };
}
