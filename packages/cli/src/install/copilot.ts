import { join } from 'node:path';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { HOOK_EVENTS, HOOK_EVENT_NAMES } from '../hookEvents.js';
import { writeInstructionFile } from '../instructions.js';
import { cliArgv, cliCommand } from '../paths.js';
import { addToGitExclude } from '../tools/gitExclude.js';
import { upsertJsonConfig } from '../tools/jsonConfig.js';
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
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Pure: exactly one managed `command` entry per event (PascalCase names: accepted by both products). */
export function mergeCopilotHooks(config: Json, cli: string): Json | null {
  if (config.hooks !== undefined && !isObject(config.hooks)) return null;
  const hooks: Json = { ...(config.hooks as Json | undefined) };
  for (const event of HOOK_EVENTS) {
    const name = HOOK_EVENT_NAMES[event];
    const current = hooks[name];
    if (current !== undefined && !Array.isArray(current)) return null;
    const kept = ((current ?? []) as unknown[]).filter((e) => !(isObject(e) && isManagedHookCommand(e.command)));
    kept.push({ type: 'command', command: hookCommand(cli, event, 'copilot'), timeout: HOOK_TIMEOUT_SECONDS });
    hooks[name] = kept;
  }
  return { version: 1, ...config, hooks };
}

/** Pure: sets servers[key].agentteams. Returns null when `key` holds a non-object. */
export function mergeMcpServer(config: Json, key: 'mcpServers' | 'servers', entry: Json): Json | null {
  if (config[key] !== undefined && !isObject(config[key])) return null;
  return { ...config, [key]: { ...(config[key] as Json | undefined), agentteams: entry } };
}

const mcpArgs = (argv: Argv, repo: string): string[] => [...argv.args, 'mcp', '--tool', 'copilot', '--repo', repo];

async function writeJson(
  repo: string, rel: string, mutate: (c: Json) => Json | null, doneMsg: string, report: InstallReport,
): Promise<void> {
  let malformed = false;
  const status = await upsertJsonConfig(join(repo, rel), (c) => {
    const next = mutate(c);
    if (next === null) { malformed = true; return c; }
    return next;
  });
  if (status === 'invalid' || malformed) {
    report.warnings.push(`${rel} is not valid JSON (or has an unexpected shape); left untouched`);
    return;
  }
  report.done.push(doneMsg);
}

async function installFiles(deps: CliDeps, repo: string, cli: string, argv: Argv, report: InstallReport): Promise<void> {
  await writeJson(repo, HOOKS_REL, (c) => mergeCopilotHooks(c, cli), `installed hooks in ${HOOKS_REL} (Copilot CLI + VS Code)`, report);
  const args = mcpArgs(argv, repo);
  await writeJson(
    repo, CLI_MCP_REL,
    (c) => mergeMcpServer(c, 'mcpServers', { type: 'local', command: argv.command, args, tools: ['*'] }),
    `registered MCP server "agentteams" in ${CLI_MCP_REL} (Copilot CLI)`, report,
  );
  await writeJson(
    repo, VSCODE_MCP_REL,
    (c) => mergeMcpServer(c, 'servers', { type: 'stdio', command: argv.command, args }),
    `registered MCP server "agentteams" in ${VSCODE_MCP_REL} (VS Code agent mode)`, report,
  );
  for (const rel of [HOOKS_REL, CLI_MCP_REL, VSCODE_MCP_REL]) {
    const warning = await addToGitExclude(deps, repo, rel);
    if (warning) report.warnings.push(warning);
  }
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
