import { join } from 'node:path';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { writeInstructionFile } from '../instructions.js';
import { cliArgv, cliCommand } from '../paths.js';
import type { HookEvent } from '../hookEvents.js';
import { isCommonStopLoop, readStringCwd } from './dialects.js';
import { isPlainObject, mergeEventHooks } from './eventHooks.js';
import { addToGitExclude } from './gitExclude.js';
import { upsertJsonConfig } from './jsonConfig.js';
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

export async function installGemini(
  deps: CliDeps,
  cred: Credential,
  opts: { cli?: string; argv?: { command: string; args: string[] } } = {},
): Promise<InstallReport> {
  const report: InstallReport = { tool: 'gemini', done: [], warnings: [] };
  const repo = cred.repoPath;
  const argv = opts.argv ?? cliArgv();
  const cli = opts.cli ?? cliCommand();
  const path = join(repo, '.gemini', 'settings.json');
  const status = await upsertJsonConfig(path, (cfg) => ({
    ...cfg,
    mcpServers: {
      ...(isPlainObject(cfg.mcpServers) ? cfg.mcpServers : {}),
      agentteams: { command: argv.command, args: [...argv.args, 'mcp', '--tool', 'gemini', '--repo', repo] },
    },
    hooks: mergeEventHooks(isPlainObject(cfg.hooks) ? cfg.hooks : {}, GEMINI_EVENT_NAMES, cli, 'gemini', GEMINI_HOOK_TIMEOUT_MS),
  }));
  if (status === 'invalid') {
    report.warnings.push('.gemini/settings.json is not valid JSON; MCP server and hooks not installed');
  } else {
    report.done.push('registered MCP server "agentteams" and installed hooks in .gemini/settings.json');
    // The file embeds absolute paths: keep it out of git, but only when we created it (otherwise it is the user's).
    if (status === 'created') {
      const warning = await addToGitExclude(deps, repo, SETTINGS_REL);
      if (warning) report.warnings.push(warning);
    }
  }
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
