import type { ToolKind } from '@agentteams/shared';
import { saveCredential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { HubClient } from '../hubClient.js';
import { hubUrlFrom } from '../paths.js';
import { defaultMemberName, detectGithubSlug, repoRoot } from '../repo.js';
import { printReport, runInstallers } from './install.js';

export interface JoinOpts { agent: ToolKind; as?: string; hub?: string; install: boolean }

export async function joinCommand(deps: CliDeps, code: string, opts: JoinOpts): Promise<void> {
  const repoPath = await repoRoot(deps, deps.cwd);
  const hubUrl = hubUrlFrom(opts.hub, deps.env);
  const member = opts.as ?? defaultMemberName(deps.username);
  const res = await new HubClient(hubUrl, { fetch: deps.fetch }).joinTeam({ inviteCode: code, member, tool: opts.agent });
  const cred = {
    repoPath, tool: opts.agent, hubUrl, teamName: res.teamName, agentName: res.agentName,
    apiKey: res.apiKey, createdAt: new Date().toISOString(),
  };
  await saveCredential(deps, cred);
  deps.out(`Joined team "${res.teamName}" as ${res.agentName}.`);
  if (res.repo.provider === 'github') {
    const local = await detectGithubSlug(deps, deps.cwd);
    if (local !== res.repo.slug) {
      deps.err(`warning: this team is linked to ${res.repo.slug} but this directory's origin is ${local ?? 'none'}`);
    }
  }
  if (opts.install) printReport(deps, await runInstallers(deps, cred));
}
