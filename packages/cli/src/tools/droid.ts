import { join } from 'node:path';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { HOOK_EVENT_NAMES } from '../hookEvents.js';
import { HOOK_TIMEOUT_SECONDS } from '../install/hooksConfig.js';
import { writeInstructionFile } from '../instructions.js';
import { cliArgv, cliCommand } from '../paths.js';
import { claudeDialect } from './dialects.js';
import { mergeEventHooks } from './eventHooks.js';
import { isWritten, setMcpEntry } from './jsonConfig.js';
import { mcpStdioArgv, upsertRepoJson } from './projectMcp.js';
import type { InstallReport, ToolAdapter } from './types.js';

type Argv = { command: string; args: string[] };
const MCP_REL = '.factory/mcp.json';
const HOOKS_REL = '.factory/hooks.json';

/** Machine-specific project files (absolute CLI paths): .factory/mcp.json and .factory/hooks.json. */
async function installProject(deps: CliDeps, repo: string, cli: string, argv: Argv, report: InstallReport): Promise<void> {
  // Project MCP config (docs.factory.com/cli/configuration/mcp).
  const entry = { type: 'stdio', ...mcpStdioArgv('droid', repo, argv) };
  if (isWritten(await upsertRepoJson(deps, repo, MCP_REL, (cfg) => setMcpEntry(cfg, 'mcpServers', entry), report))) {
    report.done.push(`registered MCP server "agentteams" in ${MCP_REL}`);
  }
  // Standalone hooks.json has event names at the top level (no "hooks" wrapper); Claude-like events and contract.
  const merge = (cfg: Record<string, unknown>) => mergeEventHooks(cfg, HOOK_EVENT_NAMES, cli, 'droid', HOOK_TIMEOUT_SECONDS);
  if (isWritten(await upsertRepoJson(deps, repo, HOOKS_REL, merge, report))) report.done.push(`installed hooks in ${HOOKS_REL}`);
}

export async function installDroid(deps: CliDeps, cred: Credential, opts: { cli?: string; argv?: Argv } = {}): Promise<InstallReport> {
  const report: InstallReport = { tool: 'droid', done: [], warnings: [] };
  await installProject(deps, cred.repoPath, opts.cli ?? cliCommand(), opts.argv ?? cliArgv(), report);
  await writeInstructionFile(join(cred.repoPath, 'AGENTS.md'), cred.teamName);
  report.done.push('updated AGENTS.md');
  return report;
}

export const droidAdapter: ToolAdapter = {
  kind: 'droid',
  label: 'Factory Droid',
  tier: 'full',
  dialect: { ...claudeDialect },
  install: (deps, cred) => installDroid(deps, cred),
};
