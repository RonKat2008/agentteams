import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { cliArgv } from '../paths.js';
import { InvalidConfigShape, mergeMcpServer } from './cursorHooks.js';
import { claudeDialect } from './dialects.js';
import { upsertJsonConfig } from './jsonConfig.js';
import { writeOwnedRulesFile } from './rulesFile.js';
import type { HookDialect, InstallReport, ToolAdapter } from './types.js';

const RULES_EXTRA = [
  'agentteams cannot push messages into this editor, so you must poll:',
  '- Call `read_inbox` at the start of every task and again after each major step (after finishing a file, before committing, and before reporting done).',
  '- Treat messages marked as commands from the orchestrator as your assignments.',
].join('\n');

/** Windsurf/Devin hooks cannot inject context or gate stop; this dialect exists only so a stray hook prints nothing. */
export const windsurfDialect: HookDialect = { ...claudeDialect, render: () => ({ stdout: '', exitCode: 0 }) };

/** `$XDG_CONFIG_HOME/devin` (default ~/.config/devin) plus the legacy ~/.codeium/windsurf when that install exists. */
export function windsurfMcpPaths(deps: Pick<CliDeps, 'env' | 'homedir'>): string[] {
  const xdg = deps.env.XDG_CONFIG_HOME;
  const config = xdg !== undefined && xdg !== '' ? xdg : join(deps.homedir, '.config');
  const paths = [join(config, 'devin', 'mcp_config.json')];
  const legacy = join(deps.homedir, '.codeium', 'windsurf');
  if (existsSync(legacy)) paths.push(join(legacy, 'mcp_config.json'));
  return paths;
}

export async function installWindsurf(
  deps: CliDeps,
  cred: Credential,
  opts: { argv?: { command: string; args: string[] } } = {},
): Promise<InstallReport> {
  const report: InstallReport = { tool: 'windsurf', done: [], warnings: [] };
  const argv = opts.argv ?? cliArgv();
  // Global config is not tied to a repo, so the proxy must be told which repo's credentials to use.
  const entry = { command: argv.command, args: [...argv.args, 'mcp', '--tool', 'windsurf', '--repo', cred.repoPath] };
  for (const path of windsurfMcpPaths(deps)) {
    const shown = path.startsWith(deps.homedir) ? `~${path.slice(deps.homedir.length)}` : path;
    try {
      const status = await upsertJsonConfig(path, (c) => mergeMcpServer(c, entry));
      if (status === 'invalid') report.warnings.push(`${shown} is not valid JSON; left untouched`);
      else report.done.push(`registered MCP server "agentteams" in ${shown}`);
    } catch (e) {
      if (!(e instanceof InvalidConfigShape)) throw e;
      report.warnings.push(`${shown} has an unexpected shape (${e.message}); left untouched`);
    }
  }
  for (const dir of ['.devin', '.windsurf']) {
    await writeOwnedRulesFile(join(cred.repoPath, dir, 'rules', 'agentteams.md'), ['trigger: always_on'], cred.teamName, RULES_EXTRA);
    report.done.push(`wrote ${dir}/rules/agentteams.md`);
  }
  report.done.push('Windsurf/Devin hooks cannot inject context: teammate messages arrive only when the agent calls read_inbox, as the rules instruct');
  return report;
}

export const windsurfAdapter: ToolAdapter = {
  kind: 'windsurf',
  label: 'Windsurf / Devin',
  tier: 'mcp',
  dialect: windsurfDialect,
  install: (deps, cred) => installWindsurf(deps, cred),
};
