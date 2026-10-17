import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { linkInstructionFile } from '../instructions.js';
import { cliArgv, cliCommand, shellQuote } from '../paths.js';
import { isTracked } from '../git.js';
import { addToGitExclude } from '../tools/gitExclude.js';
import type { InstallReport } from '../tools/types.js';
import { mergeManagedHooks, type HooksJson } from './hooksConfig.js';

export type { InstallReport };

type CliArgv = ReturnType<typeof cliArgv>;

/**
 * Per-user (hook commands embed this machine's paths) and written by us before Claude Code ever creates it, so Claude's
 * own auto-ignore may not apply. Ignored via .git/info/exclude, not .gitignore: that file is shared and committed, so
 * editing it would dirty the user's tree for a rule only this clone needs; info/exclude is per-clone and also covers worktrees.
 */
const EXCLUDE_LINE = '.claude/settings.local.json';

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function registerMcp(deps: CliDeps, cred: Credential, report: InstallReport, cli: CliArgv): Promise<void> {
  const cwd = cred.repoPath;
  const argv = [cli.command, ...cli.args, 'mcp', '--tool', 'claude', '--repo', cred.repoPath];
  await deps.exec('claude', ['mcp', 'remove', 'agentteams', '--scope', 'local'], { cwd });
  const res = await deps.exec('claude', ['mcp', 'add', '--scope', 'local', 'agentteams', '--', ...argv], { cwd });
  if (res.code === 0) {
    report.done.push('registered MCP server "agentteams" with Claude Code (stdio proxy)');
  } else if (res.code === 127) {
    report.warnings.push(`Claude Code CLI not found; register the MCP server manually: claude mcp add --scope local agentteams -- ${argv.map(shellQuote).join(' ')}`);
  } else {
    report.warnings.push(`claude mcp add failed: ${(res.stderr.split('\n')[0] ?? '').split(cred.apiKey).join('<redacted>')}`);
  }
}

async function installHooks(repo: string, cli: string, report: InstallReport): Promise<void> {
  const path = join(repo, '.claude', 'settings.local.json');
  const text = await readText(path);
  let config: HooksJson = {};
  if (text !== null && text.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      config = parsed as HooksJson;
    } catch {
      report.warnings.push('.claude/settings.local.json is not valid JSON; hooks not installed');
      return;
    }
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(mergeManagedHooks(config, cli, 'claude'), null, 2)}\n`);
  report.done.push('installed hooks in .claude/settings.local.json');
}

async function gitExclude(deps: Pick<CliDeps, 'exec'>, repo: string, report: InstallReport): Promise<void> {
  const warning = await addToGitExclude(deps, repo, EXCLUDE_LINE);
  if (warning) report.warnings.push(warning);
  if (await isTracked(deps, repo, EXCLUDE_LINE)) {
    report.warnings.push(`${EXCLUDE_LINE} is tracked by git, so it is not ignored and holds machine-specific hook paths; run: git rm --cached ${EXCLUDE_LINE}`);
  }
}

export async function installClaude(deps: CliDeps, cred: Credential, opts: { cli?: string; argv?: CliArgv } = {}): Promise<InstallReport> {
  const report: InstallReport = { tool: 'claude', done: [], warnings: [] };
  const repo = cred.repoPath;
  await registerMcp(deps, cred, report, opts.argv ?? cliArgv());
  await installHooks(repo, opts.cli ?? cliCommand(), report);
  await gitExclude(deps, repo, report);
  await linkInstructionFile(repo, 'CLAUDE.md', cred.teamName, '@AGENTS.md');
  report.done.push('updated AGENTS.md (the team instructions) and CLAUDE.md (imports AGENTS.md)');
  return report;
}

/** Per-worktree Claude setup: MCP registration (cwd = worktree), managed hooks and git exclude; no instruction block. */
export async function installClaudeForWorktree(
  deps: CliDeps,
  cred: Credential,
  worktreePath: string,
  opts: { cli?: string; argv?: CliArgv } = {},
): Promise<InstallReport> {
  const report: InstallReport = { tool: 'claude', done: [], warnings: [] };
  await registerMcp(deps, { ...cred, repoPath: worktreePath }, report, opts.argv ?? cliArgv());
  await installHooks(worktreePath, opts.cli ?? cliCommand(), report);
  await gitExclude(deps, worktreePath, report);
  return report;
}
