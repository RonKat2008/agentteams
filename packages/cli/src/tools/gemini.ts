import { join } from 'node:path';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { writeInstructionFile } from '../instructions.js';
import { cliArgv, cliCommand } from '../paths.js';
import type { HookEvent } from '../hookEvents.js';
import { isCommonStopLoop, readStringCwd } from './dialects.js';
import { mergeEventHooks } from './eventHooks.js';
import { InvalidConfigShape, isPlainObject, isWritten, setMcpEntry, UserOwnedEntry } from './jsonConfig.js';
import { mcpStdioArgv, upsertRepoJson } from './projectMcp.js';
import type { HookDialect, InstallReport, ToolAdapter } from './types.js';

/** Neutral event -> Gemini CLI native event (docs: geminicli.com/docs/hooks/reference). */
export const GEMINI_EVENT_NAMES: Record<HookEvent, string> = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'BeforeAgent',
  'post-tool-use': 'AfterTool',
  stop: 'AfterAgent',
};

/** Gemini hook timeouts are milliseconds. */
const GEMINI_HOOK_TIMEOUT_MS = 10_000;
const SETTINGS_REL = '.gemini/settings.json';
type Argv = { command: string; args: string[] };

export const geminiDialect: HookDialect = {
  render(outcome) {
    if (outcome.type === 'context') {
      return {
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: GEMINI_EVENT_NAMES[outcome.event], additionalContext: outcome.text } }),
        exitCode: 0,
      };
    }
    if (outcome.type === 'block') return { stdout: JSON.stringify({ decision: 'deny', reason: outcome.text }), exitCode: 0 };
    return { stdout: '', exitCode: 0 };
  },
  readCwd: readStringCwd,
  isStopLoop: isCommonStopLoop,
};

/**
 * `.gemini/settings.json`: MCP entry (stdio proxy pinned to `repo`) + hooks. A user-owned "agentteams" server is kept
 * (warned) while hooks are still installed; any other shape error leaves the file untouched.
 */
async function installSettings(deps: CliDeps, repo: string, cli: string, argv: Argv, report: InstallReport): Promise<void> {
  const entry = mcpStdioArgv('gemini', repo, argv);
  let skipped: string | null = null;
  const status = await upsertRepoJson(deps, repo, SETTINGS_REL, (cfg) => {
    if (cfg.hooks !== undefined && !isPlainObject(cfg.hooks)) throw new InvalidConfigShape('"hooks" is not an object');
    let next = cfg;
    try {
      next = setMcpEntry(cfg, 'mcpServers', entry);
    } catch (e) {
      if (!(e instanceof UserOwnedEntry)) throw e;
      skipped = e.message;
    }
    return { ...next, hooks: mergeEventHooks(isPlainObject(cfg.hooks) ? cfg.hooks : {}, GEMINI_EVENT_NAMES, cli, 'gemini', GEMINI_HOOK_TIMEOUT_MS) };
  }, report);
  if (!isWritten(status)) return;
  if (skipped !== null) report.warnings.push(`${SETTINGS_REL}: ${skipped}; MCP server not registered (hooks installed)`);
  else report.done.push(`registered MCP server "agentteams" in ${SETTINGS_REL}`);
  report.done.push(`installed hooks in ${SETTINGS_REL}`);
}

export async function installGemini(
  deps: CliDeps,
  cred: Credential,
  opts: { cli?: string; argv?: Argv } = {},
): Promise<InstallReport> {
  const report: InstallReport = { tool: 'gemini', done: [], warnings: [] };
  const repo = cred.repoPath;
  const argv = opts.argv ?? cliArgv();
  const cli = opts.cli ?? cliCommand();
  await installSettings(deps, repo, cli, argv, report);
  await writeInstructionFile(join(repo, 'GEMINI.md'), cred.teamName);
  report.done.push('updated GEMINI.md');
  return report;
}

export const geminiAdapter: ToolAdapter = {
  kind: 'gemini',
  label: 'Gemini CLI',
  tier: 'full',
  dialect: geminiDialect,
  install: (deps, cred) => installGemini(deps, cred),
};
