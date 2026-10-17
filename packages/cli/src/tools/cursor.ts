import { join } from 'node:path';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { writeInstructionFile } from '../instructions.js';
import { cliArgv, cliCommand } from '../paths.js';
import type { HookEvent } from '../hookEvents.js';
import { CURSOR_EVENTS, mergeCursorHooks } from './cursorHooks.js';
import { isCommonStopLoop, readStringCwd } from './dialects.js';
import { isWritten, setMcpEntry } from './jsonConfig.js';
import { mcpStdioArgv, upsertRepoJson } from './projectMcp.js';
import { writeOwnedRulesFile } from './rulesFile.js';
import type { HookDialect, InstallReport, ToolAdapter } from './types.js';

export const cursorDialect: HookDialect = {
  contextEvents: new Set<HookEvent>(CURSOR_EVENTS.map(([, e]) => e).filter((e) => e !== 'stop')),
  render(outcome) {
    // Cursor ignores context from beforeSubmitPrompt (user-prompt-submit); emit nothing there.
    if (outcome.type === 'context' && outcome.event !== 'user-prompt-submit') {
      return { stdout: JSON.stringify({ additional_context: outcome.text }), exitCode: 0 };
    }
    if (outcome.type === 'block') return { stdout: JSON.stringify({ followup_message: outcome.text }), exitCode: 0 };
    return { stdout: '', exitCode: 0 };
  },
  // Cursor sends workspace_roots (not cwd) on most events; postToolUse also carries cwd.
  readCwd(input) {
    const roots = input.workspace_roots;
    if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0] !== '') return roots[0];
    return readStringCwd(input);
  },
  isStopLoop: isCommonStopLoop,
};

type Argv = { command: string; args: string[] };

/** Machine-specific project files (absolute CLI paths): .cursor/mcp.json and .cursor/hooks.json. */
async function installProject(deps: CliDeps, repo: string, cli: string, argv: Argv, report: InstallReport): Promise<void> {
  const entry = { type: 'stdio', ...mcpStdioArgv('cursor', repo, argv) };
  if (isWritten(await upsertRepoJson(deps, repo, '.cursor/mcp.json', (c) => setMcpEntry(c, 'mcpServers', entry), report))) {
    report.done.push('registered MCP server "agentteams" in .cursor/mcp.json');
  }
  if (isWritten(await upsertRepoJson(deps, repo, '.cursor/hooks.json', (c) => mergeCursorHooks(c, cli, 'cursor'), report))) {
    report.done.push('installed hooks in .cursor/hooks.json');
  }
}

export async function installCursor(deps: CliDeps, cred: Credential, opts: { cli?: string; argv?: Argv } = {}): Promise<InstallReport> {
  const report: InstallReport = { tool: 'cursor', done: [], warnings: [] };
  await installProject(deps, cred.repoPath, opts.cli ?? cliCommand(), opts.argv ?? cliArgv(), report);
  await writeOwnedRulesFile(
    cred.repoPath,
    '.cursor/rules/agentteams.mdc',
    ['description: agentteams multi-agent coordination', 'alwaysApply: true'],
    cred.teamName,
    report,
    '',
    { pointer: true }, // Cursor reads AGENTS.md itself: no second copy of the steps to drift
  );
  await writeInstructionFile(join(cred.repoPath, 'AGENTS.md'), cred.teamName);
  report.done.push('updated AGENTS.md');
  report.done.push('Cursor has no per-prompt context hook: teammate messages arrive after tool calls and when the agent stops; restart Cursor and enable the project MCP server once');
  return report;
}

export async function installCursorForWorktree(
  deps: CliDeps,
  _cred: Credential,
  worktreePath: string,
  opts: { cli?: string; argv?: Argv } = {},
): Promise<InstallReport> {
  const report: InstallReport = { tool: 'cursor', done: [], warnings: [] };
  await installProject(deps, worktreePath, opts.cli ?? cliCommand(), opts.argv ?? cliArgv(), report);
  return report;
}

export const cursorAdapter: ToolAdapter = {
  kind: 'cursor',
  label: 'Cursor',
  tier: 'full',
  launch: 'cursor .',
  dialect: cursorDialect,
  install: (deps, cred) => installCursor(deps, cred),
  installForWorktree: (deps, cred, worktreePath) => installCursorForWorktree(deps, cred, worktreePath),
};
