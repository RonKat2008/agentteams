import type { ToolKind } from '@agentteams/shared';
import { makePalette } from '../color.js';
import type { CliDeps } from '../deps.js';
import { formatStatusTable } from '../statusTable.js';
import { syncSummaryLine } from '../git/syncState.js';
import { clientFor, requireCredential } from './shared.js';

export async function statusCommand(deps: CliDeps, opts: { agent?: ToolKind }): Promise<void> {
  const cred = await requireCredential(deps, opts.agent);
  const status = await clientFor(deps, cred).status();
  for (const line of formatStatusTable(status, cred.agentName, makePalette(deps.color))) deps.out(line);
  if (cred.transport === 'git') deps.out(`Sync: ${await syncSummaryLine(deps, cred.repoPath)}`);
}
