import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { writeInstructionFile } from '../instructions.js';
import { cliCommand } from '../paths.js';
import { addToGitExclude } from '../tools/gitExclude.js';
import type { InstallReport } from '../tools/types.js';
import { mergeManagedHooks, type HooksJson } from './hooksConfig.js';

export type { InstallReport };

const EXCLUDE_LINE = '.claude/settings.local.json';

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function registerMcp(deps: CliDeps, cred: Credential, report: InstallReport): Promise<void> {
  const cwd = cred.repoPath;
  const url = `${cred.hubUrl}/mcp`;
  await deps.exec('claude', ['mcp', 'remove', 'agentteams', '--scope', 'local'], { cwd });
  const res = await deps.exec(
    'claude',
    ['mcp', 'add', '--transport', 'http', '--scope', 'local', 'agentteams', url, '--header', `Authorization: Bearer ${cred.apiKey}`],
    { cwd },
  );
  if (res.code === 0) {
    report.done.push('registered MCP server "agentteams" with Claude Code');
  } else if (res.code === 127) {
    report.warnings.push(
      `Claude Code CLI not found; register the MCP server manually: claude mcp add --transport http --scope local agentteams ${url} --header "Authorization: Bearer <key from ~/.agentteams/credentials.json>"`,
    );
  } else {
    const first = res.stderr.split('\n')[0] ?? '';
    report.warnings.push(`claude mcp add failed: ${first.split(cred.apiKey).join('<redacted>')}`);
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
}

export async function installClaude(deps: CliDeps, cred: Credential, opts: { cli?: string } = {}): Promise<InstallReport> {
  const report: InstallReport = { tool: 'claude', done: [], warnings: [] };
  const repo = cred.repoPath;
  await registerMcp(deps, cred, report);
  await installHooks(repo, opts.cli ?? cliCommand(), report);
  await gitExclude(deps, repo, report);
  await writeInstructionFile(join(repo, 'CLAUDE.md'), cred.teamName);
  report.done.push('updated CLAUDE.md');
  return report;
}

/** Per-worktree Claude setup: MCP registration (cwd = worktree), managed hooks and git exclude; no instruction block. */
export async function installClaudeForWorktree(
  deps: CliDeps,
  cred: Credential,
  worktreePath: string,
  opts: { cli?: string } = {},
): Promise<InstallReport> {
  const report: InstallReport = { tool: 'claude', done: [], warnings: [] };
  await registerMcp(deps, { ...cred, repoPath: worktreePath }, report);
  await installHooks(worktreePath, opts.cli ?? cliCommand(), report);
  await gitExclude(deps, worktreePath, report);
  return report;
}
