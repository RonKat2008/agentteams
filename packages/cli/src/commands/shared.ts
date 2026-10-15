import type { ToolKind } from '@agentteams/shared';
import { loadCredentials, resolveCredential, type Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { HubClient } from '../hubClient.js';
import { repoRoot } from '../repo.js';

export async function requireCredential(deps: CliDeps, agent?: ToolKind): Promise<Credential> {
  const cred = await resolveCredential(deps, deps.cwd, agent);
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
