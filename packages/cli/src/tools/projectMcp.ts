import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { ToolKind } from '@agentteams/shared';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { writeInstructionFile } from '../instructions.js';
import { cliArgv } from '../paths.js';
import { addToGitExclude } from './gitExclude.js';
import { readTextIfExists, upsertJsonConfig } from './jsonConfig.js';
import type { InstallReport } from './types.js';

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Stdio argv for `agentteams mcp --tool <kind> --repo <repo>` as { command, args }. */
export function mcpStdioArgv(tool: ToolKind, repo: string): { command: string; args: string[] } {
  const { command, args } = cliArgv();
  return { command, args: [...args, 'mcp', '--tool', tool, '--repo', repo] };
}

/** Returns a copy of `cfg` with `cfg[key][name] = entry` (other keys and servers untouched). */
export function withServer(cfg: Record<string, unknown>, key: string, name: string, entry: unknown): Record<string, unknown> {
  const servers = isPlainObject(cfg[key]) ? cfg[key] : {};
  return { ...cfg, [key]: { ...servers, [name]: entry } };
}

/**
 * Upserts a JSON config inside the repo that embeds machine-specific absolute paths. Git-excludes it when we
 * created it; warns when it pre-existed (it may be committed).
 */
export async function upsertRepoConfig(
  deps: CliDeps,
  repo: string,
  relPath: string,
  mutate: (cfg: Record<string, unknown>) => Record<string, unknown>,
  report: InstallReport,
): Promise<void> {
  const path = join(repo, relPath);
  const existed = (await readTextIfExists(path)) !== null;
  const status = await upsertJsonConfig(path, mutate);
  if (status === 'invalid') {
    report.warnings.push(`${relPath} is not valid JSON; left untouched and agentteams MCP server not registered there`);
    return;
  }
  report.done.push(`registered MCP server "agentteams" in ${relPath}`);
  if (!existed) {
    const w = await addToGitExclude(deps, repo, relPath);
    if (w) report.warnings.push(w);
  } else {
    report.warnings.push(`${relPath} already existed; the agentteams entry contains machine-specific paths, do not commit it`);
  }
}

/** Writes the managed instruction block into a rules/instructions file (created with parents if missing). */
export async function writeRulesFile(repo: string, relPath: string, cred: Credential, report: InstallReport): Promise<void> {
  const path = join(repo, relPath);
  await mkdir(dirname(path), { recursive: true });
  await writeInstructionFile(path, cred.teamName);
  report.done.push(`updated ${relPath}`);
}
