import { resolve } from 'node:path';
import type { ToolKind } from '@agentteams/shared';
import { resolveCredentialForCwd } from '../credentials.js';
import type { CliDeps } from '../deps.js';

/** How long `sync` waits for a running round (detached syncs queue behind it so no write is left unpushed). */
const LOCK_WAIT_MS = 60_000;

export interface SyncCommandOpts { repo?: string; tool?: ToolKind; quiet?: boolean }

/** `agentteams sync`: one round for this repo's git team. Returns the exit code (1 when the round failed). */
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
  const summary = await syncRound(deps, cred.repoPath, cred, { waitMs: LOCK_WAIT_MS });
  if (!opts.quiet) deps.out(formatSyncSummary(summary));
  return summary.ok || summary.skipped ? 0 : 1;
}
