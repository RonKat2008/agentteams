import { join } from 'node:path';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { writeInstructionFile } from '../instructions.js';
import { cliArgv, cliCommand } from '../paths.js';
import { InvalidConfigShape, mergeCursorHooks, mergeMcpServer } from './cursorHooks.js';
import { isCommonStopLoop, readStringCwd } from './dialects.js';
import { addToGitExclude } from './gitExclude.js';
import { upsertJsonConfig, type JsonConfig } from './jsonConfig.js';
import { writeOwnedRulesFile } from './rulesFile.js';
import type { HookDialect, InstallReport, ToolAdapter } from './types.js';

export const cursorDialect: HookDialect = {
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

async function upsert(path: string, label: string, mutate: (c: JsonConfig) => JsonConfig, report: InstallReport): Promise<boolean> {
  try {
    if ((await upsertJsonConfig(path, mutate)) === 'invalid') {
      report.warnings.push(`${label} is not valid JSON; left untouched`);
      return false;
    }
  } catch (e) {
    if (!(e instanceof InvalidConfigShape)) throw e;
    report.warnings.push(`${label} has an unexpected shape (${e.message}); left untouched`);
    return false;
  }
  return true;
}

async function installProject(deps: CliDeps, repo: string, cli: string, argv: Argv, report: InstallReport): Promise<void> {
  const entry = { type: 'stdio', command: argv.command, args: [...argv.args, 'mcp', '--tool', 'cursor', '--repo', repo] };
  if (await upsert(join(repo, '.cursor', 'mcp.json'), '.cursor/mcp.json', (c) => mergeMcpServer(c, entry), report)) {
    report.done.push('registered MCP server "agentteams" in .cursor/mcp.json');
  }
  if (await upsert(join(repo, '.cursor', 'hooks.json'), '.cursor/hooks.json', (c) => mergeCursorHooks(c, cli, 'cursor'), report)) {
    report.done.push('installed hooks in .cursor/hooks.json');
  }
  // Both files embed absolute paths to this machine's CLI.
  for (const rel of ['.cursor/mcp.json', '.cursor/hooks.json']) {
    const warning = await addToGitExclude(deps, repo, rel);
    if (warning) report.warnings.push(warning);
  }
}

export async function installCursor(deps: CliDeps, cred: Credential, opts: { cli?: string; argv?: Argv } = {}): Promise<InstallReport> {
  const report: InstallReport = { tool: 'cursor', done: [], warnings: [] };
  await installProject(deps, cred.repoPath, opts.cli ?? cliCommand(), opts.argv ?? cliArgv(), report);
  await writeOwnedRulesFile(
    join(cred.repoPath, '.cursor', 'rules', 'agentteams.mdc'),
    ['description: agentteams multi-agent coordination', 'alwaysApply: true'],
    cred.teamName,
  );
  report.done.push('wrote .cursor/rules/agentteams.mdc');
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
  dialect: cursorDialect,
  install: (deps, cred) => installCursor(deps, cred),
  installForWorktree: (deps, cred, worktreePath) => installCursorForWorktree(deps, cred, worktreePath),
};
