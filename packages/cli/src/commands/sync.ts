import { resolve } from 'node:path';
import type { ToolKind } from '@agentteams/shared';
import { loadCredentials, resolveCredentialForCwd, type Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';

/** How long an interactive `sync` waits for a running round. Detached (`--quiet`) syncs coalesce instead (C7). */
const LOCK_WAIT_MS = 60_000;

export interface SyncCommandOpts { repo?: string; tool?: ToolKind; quiet?: boolean }

/**
 * The git credentials to sync: with --tool just that one; otherwise every git agent of the repo, since each agent
 * publishes only its own queued ops (two agents in one clone would otherwise leave one agent's writes unsent).
 */
async function gitCredentials(deps: CliDeps, cred: Credential, tool?: ToolKind): Promise<Credential[]> {
  if (tool) return [cred];
  const all = (await loadCredentials(deps)).filter((c) => c.repoPath === cred.repoPath && c.transport === 'git');
  return all.length > 0 ? all.sort((a, b) => a.tool.localeCompare(b.tool)) : [cred];
}

/** `agentteams sync`: one round per agent for this repo's git team. Returns the exit code (1 when a round failed). */
export async function syncCommand(deps: CliDeps, opts: SyncCommandOpts): Promise<number> {
  const cwd = opts.repo ? resolve(deps.cwd, opts.repo) : deps.cwd;
  const cred = await resolveCredentialForCwd(deps, cwd, opts.tool);
  if (!cred) {
    if (!opts.quiet) deps.err(`agentteams: no team credentials for ${cwd}`);
    return 1;
  }
  if (cred.transport !== 'git') {
    if (!opts.quiet) deps.out('agentteams: this team does not sync through git; nothing to do');
    return 0;
  }
  const { formatSyncSummary, syncRound } = await import('../git/sync.js');
  const creds = await gitCredentials(deps, cred, opts.tool);
  let code = 0;
  for (const c of creds) {
    const summary = await syncRound(deps, c.repoPath, c, opts.quiet ? { coalesce: true } : { waitMs: LOCK_WAIT_MS });
    const line = formatSyncSummary(summary);
    if (!opts.quiet) deps.out(creds.length > 1 ? line.replace(/^agentteams: /, `agentteams: ${c.agentName} `) : line);
    if (!summary.ok && !summary.skipped) code = 1;
  }
  return code;
}
