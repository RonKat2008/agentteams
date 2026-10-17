import type { ToolKind } from '@agentteams/shared';
import { makePalette } from '../color.js';
import type { CliDeps } from '../deps.js';
import { formatStatusTable } from '../statusTable.js';
import { syncSummaryLine } from '../git/syncState.js';
import { clientFor, readableTeams } from './shared.js';

/** Every team this repo has credentials for (usually one); all of the repo's own agents are marked "you". */
export async function statusCommand(deps: CliDeps, opts: { agent?: ToolKind }): Promise<void> {
  const teams = await readableTeams(deps, opts.agent);
  const palette = makePalette(deps.color);
  for (const [i, { cred, mine }] of teams.entries()) {
    if (i > 0) deps.out('');
    const status = await clientFor(deps, cred).status();
    for (const line of formatStatusTable(status, mine, palette)) deps.out(line);
    if (cred.transport === 'git') deps.out(`Sync: ${await syncSummaryLine(deps, cred.repoPath)}`);
  }
}
