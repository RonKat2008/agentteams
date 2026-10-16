import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { cliArgv } from '../paths.js';
import { addToGitExclude } from './gitExclude.js';
import { isWritten, readTextIfExists, setMcpEntry } from './jsonConfig.js';
import { OPENCODE_PLUGIN_MARKER, opencodeDialect, renderOpencodePlugin } from './opencodePlugin.js';
import { mcpStdioArgv, upsertRepoJson, writeRulesFile } from './projectMcp.js';
import type { InstallReport, ToolAdapter } from './types.js';

export const OPENCODE_PLUGIN_PATH = '.opencode/plugins/agentteams.js';
const CONFIG_REL = 'opencode.json';
const SCHEMA = 'https://opencode.ai/config.json';

async function installPlugin(deps: CliDeps, repo: string, report: InstallReport): Promise<void> {
  const path = join(repo, OPENCODE_PLUGIN_PATH);
  const old = await readTextIfExists(path);
  if (old !== null && !old.includes(OPENCODE_PLUGIN_MARKER)) {
    report.warnings.push(`${OPENCODE_PLUGIN_PATH} exists and is not managed by agentteams; left untouched (hooks not installed)`);
    return;
  }
  const { command, args } = cliArgv();
  const next = renderOpencodePlugin(command, args[0] ?? '');
  if (old !== next) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, next);
  }
  report.done.push(`installed plugin ${OPENCODE_PLUGIN_PATH}`);
  const w = await addToGitExclude(deps, repo, OPENCODE_PLUGIN_PATH);
  if (w) report.warnings.push(w);
}

/** Machine-specific files: `opencode.json` mcp entry (stdio proxy pinned to `repo`) and the managed plugin. */
async function installRepoFiles(deps: CliDeps, repo: string, report: InstallReport): Promise<void> {
  const { command, args } = mcpStdioArgv('opencode', repo);
  const entry = { type: 'local', command: [command, ...args], enabled: true };
  const status = await upsertRepoJson(
    deps, repo, CONFIG_REL,
    (c) => ({ ...(typeof c.$schema === 'string' ? {} : { $schema: SCHEMA }), ...setMcpEntry(c, 'mcp', entry) }),
    report,
  );
  if (isWritten(status)) report.done.push(`registered MCP server "agentteams" in ${CONFIG_REL}`);
  await installPlugin(deps, repo, report);
}

/** OpenCode: `opencode.json` mcp entry + managed plugin (context injection, idle re-prompt) + AGENTS.md. */
export const opencodeAdapter: ToolAdapter = {
  kind: 'opencode',
  label: 'OpenCode',
  tier: 'full',
  dialect: opencodeDialect,
  async install(deps: CliDeps, cred: Credential): Promise<InstallReport> {
    const report: InstallReport = { tool: 'opencode', done: [], warnings: [] };
    const repo = cred.repoPath;
    await installRepoFiles(deps, repo, report);
    await writeRulesFile(repo, 'AGENTS.md', cred, report);
    return report;
  },
};
