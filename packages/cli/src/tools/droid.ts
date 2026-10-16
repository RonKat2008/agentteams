import { join } from 'node:path';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { HOOK_EVENT_NAMES } from '../hookEvents.js';
import { HOOK_TIMEOUT_SECONDS } from '../install/hooksConfig.js';
import { writeInstructionFile } from '../instructions.js';
import { cliArgv, cliCommand } from '../paths.js';
import { claudeDialect } from './dialects.js';
import { isPlainObject, mergeEventHooks } from './eventHooks.js';
import { addToGitExclude } from './gitExclude.js';
import { upsertJsonConfig } from './jsonConfig.js';
import type { InstallReport, ToolAdapter } from './types.js';

export async function installDroid(
  deps: CliDeps,
  cred: Credential,
  opts: { cli?: string; argv?: { command: string; args: string[] } } = {},
): Promise<InstallReport> {
  const report: InstallReport = { tool: 'droid', done: [], warnings: [] };
  const repo = cred.repoPath;
  const argv = opts.argv ?? cliArgv();
  const cli = opts.cli ?? cliCommand();

  // Project MCP config: .factory/mcp.json (docs.factory.com/cli/configuration/mcp).
  const mcpStatus = await upsertJsonConfig(join(repo, '.factory', 'mcp.json'), (cfg) => ({
    ...cfg,
    mcpServers: {
      ...(isPlainObject(cfg.mcpServers) ? cfg.mcpServers : {}),
      agentteams: { type: 'stdio', command: argv.command, args: [...argv.args, 'mcp', '--tool', 'droid', '--repo', repo] },
    },
  }));
  if (mcpStatus === 'invalid') report.warnings.push('.factory/mcp.json is not valid JSON; MCP server not installed');
  else report.done.push('registered MCP server "agentteams" in .factory/mcp.json');

  // Standalone hooks.json has event names at the top level (no "hooks" wrapper); Claude-like events and contract.
  const hooksStatus = await upsertJsonConfig(join(repo, '.factory', 'hooks.json'), (cfg) =>
    mergeEventHooks(cfg, HOOK_EVENT_NAMES, cli, 'droid', HOOK_TIMEOUT_SECONDS));
  if (hooksStatus === 'invalid') report.warnings.push('.factory/hooks.json is not valid JSON; hooks not installed');
  else report.done.push('installed hooks in .factory/hooks.json');

  // Both files embed absolute paths: exclude each only if we created it.
  for (const [status, rel] of [[mcpStatus, '.factory/mcp.json'], [hooksStatus, '.factory/hooks.json']] as const) {
    if (status !== 'created') continue;
    const warning = await addToGitExclude(deps, repo, rel);
    if (warning) report.warnings.push(warning);
  }

  await writeInstructionFile(join(repo, 'AGENTS.md'), cred.teamName);
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
