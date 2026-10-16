import { join } from 'node:path';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { HOOK_EVENT_NAMES, type HookEvent } from '../hookEvents.js';
import { writeInstructionFile } from '../instructions.js';
import { cliArgv, cliCommand } from '../paths.js';
import { InvalidConfigShape, isPlainObject as isObject, isWritten, setMcpEntry } from '../tools/jsonConfig.js';
import { upsertRepoJson } from '../tools/projectMcp.js';
import type { InstallReport } from '../tools/types.js';
import { HOOK_TIMEOUT_SECONDS, hookCommand, isManagedHookCommand } from './hooksConfig.js';

/** Shared by Copilot CLI and VS Code agent mode. Contains absolute CLI paths, so it is git-excluded. */
export const HOOKS_REL = '.github/hooks/agentteams.json';
/** Copilot CLI project MCP (`mcpServers`). */
export const CLI_MCP_REL = '.github/mcp.json';
/** VS Code agent mode workspace MCP (`servers`). */
export const VSCODE_MCP_REL = '.vscode/mcp.json';
export const INSTRUCTIONS_REL = '.github/copilot-instructions.md';

type Json = Record<string, unknown>;
type Argv = { command: string; args: string[] };

/** Events we hook. No user-prompt-submit: Copilot discards its output, so it could only lose messages. */
export const COPILOT_EVENTS: readonly HookEvent[] = ['session-start', 'post-tool-use', 'stop'];

const isManagedEntry = (e: unknown): boolean => isObject(e) && isManagedHookCommand(e.command);

/** Pure: exactly one managed `command` entry per event (PascalCase names: accepted by both products). Throws on bad shapes. */
export function mergeCopilotHooks(config: Json, cli: string): Json {
  if (config.hooks !== undefined && !isObject(config.hooks)) throw new InvalidConfigShape('"hooks" is not an object');
  const hooks: Json = { ...(config.hooks as Json | undefined) };
  // Drop managed UserPromptSubmit entries from older installs; keep the user's.
  const ups = hooks[HOOK_EVENT_NAMES['user-prompt-submit']];
  if (Array.isArray(ups)) {
    const kept = ups.filter((e) => !isManagedEntry(e));
    if (kept.length > 0) hooks[HOOK_EVENT_NAMES['user-prompt-submit']] = kept;
    else delete hooks[HOOK_EVENT_NAMES['user-prompt-submit']];
  }
  for (const event of COPILOT_EVENTS) {
    const name = HOOK_EVENT_NAMES[event];
    const current = hooks[name];
    if (current !== undefined && !Array.isArray(current)) throw new InvalidConfigShape(`"hooks.${name}" is not an array`);
    const kept = ((current ?? []) as unknown[]).filter((e) => !isManagedEntry(e));
    kept.push({ type: 'command', command: hookCommand(cli, event, 'copilot'), timeout: HOOK_TIMEOUT_SECONDS });
    hooks[name] = kept;
  }
  return { version: 1, ...config, hooks };
}

const mcpArgs = (argv: Argv, repo: string): string[] => [...argv.args, 'mcp', '--tool', 'copilot', '--repo', repo];

async function writeJson(
  deps: CliDeps, repo: string, rel: string, mutate: (c: Json) => Json, doneMsg: string, report: InstallReport,
): Promise<void> {
  if (isWritten(await upsertRepoJson(deps, repo, rel, mutate, report))) report.done.push(doneMsg);
}

async function installFiles(deps: CliDeps, repo: string, cli: string, argv: Argv, report: InstallReport): Promise<void> {
  await writeJson(deps, repo, HOOKS_REL, (c) => mergeCopilotHooks(c, cli), `installed hooks in ${HOOKS_REL} (Copilot CLI + VS Code)`, report);
  const args = mcpArgs(argv, repo);
  await writeJson(
    deps, repo, CLI_MCP_REL,
    (c) => setMcpEntry(c, 'mcpServers', { type: 'local', command: argv.command, args, tools: ['*'] }),
    `registered MCP server "agentteams" in ${CLI_MCP_REL} (Copilot CLI)`, report,
  );
  await writeJson(
    deps, repo, VSCODE_MCP_REL,
    (c) => setMcpEntry(c, 'servers', { type: 'stdio', command: argv.command, args }),
    `registered MCP server "agentteams" in ${VSCODE_MCP_REL} (VS Code agent mode)`, report,
  );
}

export interface CopilotOpts { cli?: string; argv?: Argv }

export async function installCopilot(deps: CliDeps, cred: Credential, opts: CopilotOpts = {}): Promise<InstallReport> {
  const report: InstallReport = { tool: 'copilot', done: [], warnings: [] };
  const repo = cred.repoPath;
  await installFiles(deps, repo, opts.cli ?? cliCommand(), opts.argv ?? cliArgv(), report);
  // Committable, no absolute paths: not git-excluded.
  await writeInstructionFile(join(repo, INSTRUCTIONS_REL), cred.teamName);
  await writeInstructionFile(join(repo, 'AGENTS.md'), cred.teamName);
  report.done.push(`updated ${INSTRUCTIONS_REL} and AGENTS.md`);
  report.done.push('Copilot CLI: trust the folder to load project MCP servers; per-prompt injection is unsupported there (hooks inject on session start and after tools)');
  return report;
}

/** Per-worktree: untracked config files do not follow `git worktree add`, so write them there too. */
export async function installCopilotForWorktree(
  deps: CliDeps, _cred: Credential, worktreePath: string, opts: CopilotOpts = {},
): Promise<InstallReport> {
  const report: InstallReport = { tool: 'copilot', done: [], warnings: [] };
  await installFiles(deps, worktreePath, opts.cli ?? cliCommand(), opts.argv ?? cliArgv(), report);
  return report;
}
