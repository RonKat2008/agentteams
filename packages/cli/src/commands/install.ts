import type { ToolKind } from '@agentteams/shared';
import { realpath } from 'node:fs/promises';
import { loadCredentials, type Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { installClaude, type InstallReport } from '../install/claude.js';
import { installCodex } from '../install/codex.js';
import { repoRoot } from '../repo.js';
import { noCredentialsMessage } from './shared.js';

export async function runInstallers(deps: CliDeps, cred: Credential): Promise<InstallReport> {
  if (cred.tool === 'claude') return installClaude(deps, cred);
  if (cred.tool === 'codex') return installCodex(deps, cred);
  return { tool: cred.tool, done: [], warnings: [`no installer for tool "${cred.tool}"`] };
}

export function printReport(deps: CliDeps, report: InstallReport): void {
  for (const line of report.done) deps.out(`  ✓ ${line}`);
  for (const line of report.warnings) deps.err(`  ! ${line}`);
}

export async function installCommand(deps: CliDeps, opts: { agent?: ToolKind | 'all' }): Promise<void> {
  const raw = await repoRoot(deps, deps.cwd);
  const repo = await realpath(raw).catch(() => raw);
  const wanted = opts.agent && opts.agent !== 'all' ? opts.agent : undefined;
  const creds = (await loadCredentials(deps)).filter((c) => c.repoPath === repo && (!wanted || c.tool === wanted));
  if (creds.length === 0) throw new Error(noCredentialsMessage(repo));
  for (const cred of creds) {
    deps.out(`Installing agentteams for ${cred.tool} (${cred.agentName})`);
    printReport(deps, await runInstallers(deps, cred));
  }
}
