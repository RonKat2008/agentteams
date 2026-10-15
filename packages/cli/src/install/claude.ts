import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ToolKind } from '@agentteams/shared';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { writeInstructionFile } from '../instructions.js';
import { cliCommand } from '../paths.js';
import { mergeManagedHooks, type HooksJson } from './hooksConfig.js';

export interface InstallReport { tool: ToolKind; done: string[]; warnings: string[] }

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

async function gitExclude(repo: string): Promise<void> {
  const gitDir = join(repo, '.git');
  const s = await stat(gitDir).catch(() => null);
  if (!s?.isDirectory()) return;
  const path = join(gitDir, 'info', 'exclude');
  const existing = (await readText(path)) ?? '';
  if (existing.split('\n').some((l) => l.trim() === EXCLUDE_LINE)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`}${EXCLUDE_LINE}\n`);
}

export async function installClaude(deps: CliDeps, cred: Credential, opts: { cli?: string } = {}): Promise<InstallReport> {
  const report: InstallReport = { tool: 'claude', done: [], warnings: [] };
  const repo = cred.repoPath;
  await registerMcp(deps, cred, report);
  await installHooks(repo, opts.cli ?? cliCommand(), report);
  await gitExclude(repo);
  await writeInstructionFile(join(repo, 'CLAUDE.md'), cred.teamName);
  report.done.push('updated CLAUDE.md');
  return report;
}
