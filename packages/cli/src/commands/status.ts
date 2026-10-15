import type { ToolKind } from '@agentteams/shared';
import type { CliDeps } from '../deps.js';
import { clientFor, requireCredential } from './shared.js';

export async function statusCommand(deps: CliDeps, opts: { agent?: ToolKind }): Promise<void> {
  const cred = await requireCredential(deps, opts.agent);
  const { team, agents } = await clientFor(deps, cred).status();
  deps.out(`Team "${team.name}" (repo ${team.repo.slug ?? 'local'}) — orchestrator ${team.orchestrator ?? 'none'}`);
  for (const a of agents) {
    const task = a.currentTask ? `#${a.currentTask.number} ${a.currentTask.title}` : '-';
    const claims = a.claims.length > 0 ? a.claims.join(', ') : '-';
    let row = `${a.name.padEnd(20)} ${a.member.padEnd(12)} ${a.tool.padEnd(7)} ${a.presence.padEnd(8)} ${task} ${claims}`;
    if (a.isOrchestrator) row += ' *';
    if (a.name === cred.agentName) row += ' (you)';
    deps.out(row);
  }
}
