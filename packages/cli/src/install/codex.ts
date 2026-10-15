import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { writeInstructionFile } from '../instructions.js';
import { cliArgv, cliCommand, codexHome } from '../paths.js';
import type { InstallReport } from './claude.js';
import { mergeManagedHooks, type HooksJson } from './hooksConfig.js';

export const TOML_START = '# >>> agentteams (managed) >>>';
export const TOML_END = '# <<< agentteams (managed) <<<';

export function codexMcpBlock(command: string, args: string[]): string {
  const all = [...args, 'mcp', '--tool', 'codex'].map((a) => JSON.stringify(a)).join(', ');
  return [
    TOML_START,
    '[mcp_servers.agentteams]',
    `command = ${JSON.stringify(command)}`,
    `args = [${all}]`,
    'startup_timeout_sec = 10',
    TOML_END,
    '',
  ].join('\n');
}

const norm = (t: string): string => t.replace(/["'\s]/g, '');
const SERVER = 'mcp_servers.agentteams';
const isServerPath = (n: string): boolean => n === SERVER || n.startsWith(`${SERVER}.`);

/** Line scanner: does this (non-managed) TOML text define the agentteams MCP server in any form? */
function definesAgentteamsServer(text: string): boolean {
  let table = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const m = /^\[\[?([^\]]*)\]\]?\s*(#.*)?$/.exec(line);
      if (m) {
        table = norm(m[1] ?? '');
        if (isServerPath(table)) return true;
      }
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = norm(line.slice(0, eq));
    if (isServerPath(key)) return true;
    if (table === 'mcp_servers' && (key === 'agentteams' || key.startsWith('agentteams.'))) return true;
    if (key === 'mcp_servers' && /["']?agentteams["']?\s*[=.]/.test(line.slice(eq + 1))) return true;
  }
  return false;
}

export function upsertCodexConfig(existing: string, block: string): string {
  const start = existing.indexOf(TOML_START);
  const endMarker = start === -1 ? -1 : existing.indexOf(TOML_END, start);
  const managed = start !== -1 && endMarker !== -1;
  let before = existing;
  let after = '';
  if (managed) {
    let end = endMarker + TOML_END.length;
    if (existing[end] === '\n') end += 1;
    before = existing.slice(0, start);
    after = existing.slice(end);
  }
  if (definesAgentteamsServer(before + after)) {
    throw new Error(
      '~/.codex/config.toml already defines [mcp_servers.agentteams] outside the agentteams-managed block; remove it and re-run "agentteams install"',
    );
  }
  if (managed) return before + block + after;
  if (existing === '') return block;
  return `${existing.replace(/\n*$/, '\n')}\n${block}`;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function writeWithBackup(path: string, old: string | null, next: string): Promise<void> {
  if (old !== null && !existsSync(`${path}.bak`)) await writeFile(`${path}.bak`, old);
  await writeFile(path, next);
}

async function installMcp(home: string, argv: { command: string; args: string[] }, report: InstallReport): Promise<void> {
  const path = join(home, 'config.toml');
  const old = await readText(path);
  let next: string;
  try {
    next = upsertCodexConfig(old ?? '', codexMcpBlock(argv.command, argv.args));
  } catch (e) {
    report.warnings.push((e as Error).message);
    return;
  }
  if (next !== (old ?? '')) await writeWithBackup(path, old, next);
  report.done.push('registered MCP server "agentteams" in ~/.codex/config.toml');
}

async function installHooks(home: string, cli: string, report: InstallReport): Promise<void> {
  const path = join(home, 'hooks.json');
  const text = await readText(path);
  let config: HooksJson = {};
  if (text !== null && text.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      config = parsed as HooksJson;
    } catch {
      report.warnings.push('~/.codex/hooks.json is not valid JSON; hooks not installed');
      return;
    }
  }
  const next = `${JSON.stringify(mergeManagedHooks(config, cli, 'codex'), null, 2)}\n`;
  if (next !== text) await writeWithBackup(path, text, next);
  report.done.push('installed hooks in ~/.codex/hooks.json');
  report.done.push('approve the agentteams hooks once in Codex with /hooks (Codex requires this for new hooks)');
}

export async function installCodex(
  deps: CliDeps,
  cred: Credential,
  opts: { cli?: string; argv?: { command: string; args: string[] } } = {},
): Promise<InstallReport> {
  const report: InstallReport = { tool: 'codex', done: [], warnings: [] };
  const home = codexHome(deps);
  await mkdir(home, { recursive: true });
  await installMcp(home, opts.argv ?? cliArgv(), report);
  await installHooks(home, opts.cli ?? cliCommand(), report);
  await writeInstructionFile(join(cred.repoPath, 'AGENTS.md'), cred.teamName);
  report.done.push('updated AGENTS.md');
  return report;
}
