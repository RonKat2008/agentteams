import { claudeDialect } from './dialects.js';
import { mcpStdioArgv, upsertRepoConfig, withServer, writeRulesFile } from './projectMcp.js';
import type { InstallReport, ToolAdapter } from './types.js';

/** Roo Code: project `.roo/mcp.json` (mcpServers, stdio) + `.roo/rules/agentteams.md`. No hooks. */
export const rooAdapter: ToolAdapter = {
  kind: 'roo',
  label: 'Roo Code',
  tier: 'mcp',
  dialect: claudeDialect,
  async install(deps, cred) {
    const report: InstallReport = { tool: 'roo', done: [], warnings: [] };
    const repo = cred.repoPath;
    const entry = { ...mcpStdioArgv('roo', repo), disabled: false };
    await upsertRepoConfig(deps, repo, '.roo/mcp.json', (c) => withServer(c, 'mcpServers', 'agentteams', entry), report);
    await writeRulesFile(repo, '.roo/rules/agentteams.md', cred, report);
    return report;
  },
};
