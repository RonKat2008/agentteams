import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliDeps } from '../deps.js';
import { claudeDialect } from './dialects.js';
import { upsertJsonConfig } from './jsonConfig.js';
import { mcpStdioArgv, withServer, writeRulesFile } from './projectMcp.js';
import type { InstallReport, ToolAdapter } from './types.js';

const EXTENSION_ID = 'saoudrizwan.claude-dev';

const isDir = async (p: string): Promise<boolean> => (await stat(p).catch(() => null))?.isDirectory() ?? false;

/** Cline CLI settings (override: CLINE_MCP_SETTINGS_PATH) plus the VS Code extension's file when that extension has storage. */
export async function clineSettingsPaths(deps: Pick<CliDeps, 'env' | 'homedir'>, platform: string = process.platform): Promise<string[]> {
  const cli = deps.env.CLINE_MCP_SETTINGS_PATH || join(deps.homedir, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
  const userDir =
    platform === 'darwin' ? join(deps.homedir, 'Library', 'Application Support', 'Code', 'User')
    : platform === 'win32' ? join(deps.env.APPDATA ?? join(deps.homedir, 'AppData', 'Roaming'), 'Code', 'User')
    : join(deps.env.XDG_CONFIG_HOME || join(deps.homedir, '.config'), 'Code', 'User');
  const storage = join(userDir, 'globalStorage', EXTENSION_ID);
  const paths = [cli];
  // Only touch the editor's storage if the extension is installed; never create editor directories.
  if (await isDir(storage)) paths.push(join(storage, 'settings', 'cline_mcp_settings.json'));
  return paths;
}

/** Cline: global MCP settings (stdio, pinned with --repo) + `.clinerules/agentteams.md`. Classic hooks cannot continue a turn, so none. */
export const clineAdapter: ToolAdapter = {
  kind: 'cline',
  label: 'Cline',
  tier: 'mcp',
  dialect: claudeDialect,
  async install(deps, cred) {
    const report: InstallReport = { tool: 'cline', done: [], warnings: [] };
    const entry = { ...mcpStdioArgv('cline', cred.repoPath), disabled: false, autoApprove: [] as string[] };
    for (const path of await clineSettingsPaths(deps)) {
      const shown = path.startsWith(deps.homedir) ? `~${path.slice(deps.homedir.length)}` : path;
      const status = await upsertJsonConfig(path, (c) => withServer(c, 'mcpServers', 'agentteams', entry));
      if (status === 'invalid') report.warnings.push(`${shown} is not valid JSON; left untouched and agentteams MCP server not registered there`);
      else report.done.push(`registered MCP server "agentteams" in ${shown}`);
    }
    report.warnings.push('Cline MCP settings are global: the "agentteams" entry is pinned to this repo; re-run install in another repo to repoint it');
    await writeRulesFile(cred.repoPath, '.clinerules/agentteams.md', cred, report);
    return report;
  },
};
