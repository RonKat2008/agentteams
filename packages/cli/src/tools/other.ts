import { claudeDialect } from './dialects.js';
import { mcpStdioArgv, writeRulesFile } from './projectMcp.js';
import type { InstallReport, ToolAdapter } from './types.js';

/** Snippet for any MCP-capable agent; contains no API key (the stdio proxy resolves credentials at runtime). */
export function otherMcpSnippet(repo: string): string {
  return JSON.stringify({ mcpServers: { agentteams: mcpStdioArgv('other', repo) } }, null, 2);
}

/** Generic agent: AGENTS.md block plus a ready-to-paste stdio MCP JSON snippet. */
export const otherAdapter: ToolAdapter = {
  kind: 'other',
  label: 'Other',
  tier: 'mcp',
  launch: '<start your agent>',
  dialect: claudeDialect,
  async install(_deps, cred) {
    const report: InstallReport = { tool: 'other', done: [], warnings: [] };
    await writeRulesFile(cred.repoPath, 'AGENTS.md', cred, report);
    report.done.push(
      `add this stdio MCP server to your agent's MCP config (rename the top-level key if your agent uses another, e.g. "servers"):\n${otherMcpSnippet(cred.repoPath)}`,
    );
    return report;
  },
};
