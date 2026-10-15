import type { ToolKind } from '@agentteams/shared';
import { realpath } from 'node:fs/promises';
import { loadCredentials, type Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { installClaude, type InstallReport } from '../install/claude.js';
import { installCodex } from '../install/codex.js';
import { installGitHooks } from '../install/gitHooks.js';
import { repoRoot } from '../repo.js';
import { noCredentialsMessage } from './shared.js';

export async function runInstallers(deps: CliDeps, cred: Credential): Promise<InstallReport> {
  const report: InstallReport =
    cred.tool === 'claude' ? await installClaude(deps, cred)
    : cred.tool === 'codex' ? await installCodex(deps, cred)
    : { tool: cred.tool, done: [], warnings: [`no installer for tool "${cred.tool}"`] };
  const git = await installGitHooks(deps, cred.repoPath).catch((e: unknown) => ({
    status: 'skipped' as const, detail: e instanceof Error ? e.message : String(e),
  }));
  if (git.status === 'skipped') report.warnings.push(git.detail.startsWith('git hooks') ? git.detail : `git hooks not installed: ${git.detail}`);
  else report.done.push(`git: ${git.detail}`);
  return report;
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
