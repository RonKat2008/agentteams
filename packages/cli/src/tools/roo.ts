import type { CliDeps } from '../deps.js';
import { claudeDialect } from './dialects.js';
import { isWritten, setMcpEntry } from './jsonConfig.js';
import { mcpStdioArgv, upsertRepoJson, writeRulesFile } from './projectMcp.js';
import type { InstallReport, ToolAdapter } from './types.js';

const MCP_REL = '.roo/mcp.json';

/** `.roo/mcp.json` with the stdio proxy pinned to `repo` (machine-specific: git-excluded when we create it). */
async function installRooMcp(deps: CliDeps, repo: string, report: InstallReport): Promise<void> {
  const entry = { ...mcpStdioArgv('roo', repo), disabled: false };
  const status = await upsertRepoJson(deps, repo, MCP_REL, (c) => setMcpEntry(c, 'mcpServers', entry), report);
  if (isWritten(status)) report.done.push(`registered MCP server "agentteams" in ${MCP_REL}`);
}

/** Roo Code: project `.roo/mcp.json` (mcpServers, stdio) + `.roo/rules/agentteams.md`. No hooks. */
export const rooAdapter: ToolAdapter = {
  kind: 'roo',
  label: 'Roo Code',
  tier: 'mcp',
  dialect: claudeDialect,
  async install(deps, cred) {
    const report: InstallReport = { tool: 'roo', done: [], warnings: [] };
    await installRooMcp(deps, cred.repoPath, report);
    await writeRulesFile(cred.repoPath, '.roo/rules/agentteams.md', cred, report);
    return report;
  },
};
