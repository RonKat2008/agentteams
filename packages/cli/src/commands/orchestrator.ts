import type { ToolKind } from '@agentteams/shared';
import type { CliDeps } from '../deps.js';
import { clientFor, requireCredential } from './shared.js';

export async function orchestratorCommand(deps: CliDeps, target: string, opts: { agent?: ToolKind }): Promise<void> {
  const client = clientFor(deps, await requireCredential(deps, opts.agent));
  const res = await client.setOrchestrator(target);
  deps.out(`Orchestrator is now ${res.orchestrator}.`);
}
