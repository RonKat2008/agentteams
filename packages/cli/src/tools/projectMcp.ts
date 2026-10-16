import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { ToolKind } from '@agentteams/shared';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { writeInstructionFile } from '../instructions.js';
import { cliArgv } from '../paths.js';
import { addToGitExclude, isGitExcluded } from './gitExclude.js';
import { isWritten, readTextIfExists, upsertManagedJson, type JsonConfig, type ManagedStatus } from './jsonConfig.js';
import type { InstallReport } from './types.js';

/** Stdio argv for `agentteams mcp --tool <kind> --repo <repo>` as { command, args }. */
export function mcpStdioArgv(tool: ToolKind, repo: string, argv = cliArgv()): { command: string; args: string[] } {
  return { command: argv.command, args: [...argv.args, 'mcp', '--tool', tool, '--repo', repo] };
}

const pushWarning = (report: InstallReport, w: string | null): void => {
  if (w) report.warnings.push(w);
};

/**
 * A repo-local file that embeds machine-specific absolute paths: git-exclude it when we created it; when it already
 * existed and is not excluded (the user's, possibly committed), warn instead of hiding it from git.
 */
export async function excludeIfCreated(
  deps: Pick<CliDeps, 'exec'>, repo: string, relPath: string, existed: boolean, report: InstallReport,
): Promise<void> {
  if (!existed) {
    pushWarning(report, await addToGitExclude(deps, repo, relPath));
    return;
  }
  if ((await isGitExcluded(deps, repo, relPath)) === false) {
    report.warnings.push(`${relPath} already existed; the agentteams entry contains machine-specific paths, do not commit it`);
  }
}

/**
 * Upserts a repo-local JSON config with the shared refusal policy (upsertManagedJson), then applies the git-exclude
 * policy (excludeIfCreated). A `.bak` we write next to it is git-excluded too.
 */
export async function upsertRepoJson(
  deps: Pick<CliDeps, 'exec'>,
  repo: string,
  relPath: string,
  mutate: (cfg: JsonConfig) => JsonConfig,
  report: InstallReport,
): Promise<ManagedStatus> {
  const path = join(repo, relPath);
  const existed = (await readTextIfExists(path)) !== null;
  const hadBackup = existsSync(`${path}.bak`);
  const status = await upsertManagedJson(path, relPath, mutate, report);
  if (!isWritten(status)) return status;
  await excludeIfCreated(deps, repo, relPath, existed, report);
  if (!hadBackup && existsSync(`${path}.bak`)) pushWarning(report, await addToGitExclude(deps, repo, `${relPath}.bak`));
  return status;
}

/** Writes the managed instruction block into a rules/instructions file (created with parents if missing). */
export async function writeRulesFile(repo: string, relPath: string, cred: Credential, report: InstallReport): Promise<void> {
  const path = join(repo, relPath);
  await mkdir(dirname(path), { recursive: true });
  await writeInstructionFile(path, cred.teamName);
  report.done.push(`updated ${relPath}`);
}
