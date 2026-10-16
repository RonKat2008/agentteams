import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CliDeps } from '../deps.js';
import { gitPath } from '../git.js';
import { readTextIfExists } from './jsonConfig.js';

/**
 * Adds `relPath` as a line in the repo's (common) .git/info/exclude, once. Returns null on success or when
 * `repoPath` is not a git repo; a warning string if the file could not be written.
 */
export async function addToGitExclude(deps: Pick<CliDeps, 'exec'>, repoPath: string, relPath: string): Promise<string | null> {
  let path: string;
  try {
    path = await gitPath(deps, repoPath, 'info/exclude');
  } catch {
    return null; // not a git repo
  }
  try {
    const existing = (await readTextIfExists(path)) ?? '';
    if (existing.split('\n').some((l) => l.trim() === relPath)) return null;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`}${relPath}\n`);
    return null;
  } catch (err) {
    return `could not update git exclude: ${(err as Error).message}`;
  }
}

/** Whether `relPath` is already a line in the repo's .git/info/exclude; null when `repoPath` is not a git repo. */
export async function isGitExcluded(deps: Pick<CliDeps, 'exec'>, repoPath: string, relPath: string): Promise<boolean | null> {
  let path: string;
  try {
    path = await gitPath(deps, repoPath, 'info/exclude');
  } catch {
    return null;
  }
  const existing = (await readTextIfExists(path).catch(() => null)) ?? '';
  return existing.split('\n').some((l) => l.trim() === relPath);
}
