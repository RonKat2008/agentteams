import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliDeps } from '../deps.js';
import { addToGitExclude } from '../tools/gitExclude.js';

/** The integration worktree sits next to the task worktrees (same git exclude) under a name no agent can have. */
export const INTEGRATION_DIR = join('.agentteams', 'worktrees', '_merge');
export const INTEGRATION_BRANCH = 'agentteams/merge';

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
const git = (deps: CliDeps, cwd: string, args: string[]) => deps.exec('git', args, { cwd });

export const gitFailure = (args: string[], r: { code: number; stderr: string }): Error =>
  new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || `exit ${r.code}`}`);

async function gitOk(deps: CliDeps, cwd: string, args: string[]): Promise<string> {
  const r = await git(deps, cwd, args);
  if (r.code !== 0) throw gitFailure(args, r);
  return r.stdout.trim();
}

export const hasRef = async (deps: CliDeps, cwd: string, ref: string): Promise<boolean> =>
  (await git(deps, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0;

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter((l) => l !== '');

/** The remote task branches are fetched from: the git team's remote, else origin, else the only one; null without remotes. */
export async function pickRemote(deps: CliDeps, root: string, preferred?: string): Promise<string | null> {
  const remotes = lines((await git(deps, root, ['remote'])).stdout);
  for (const name of [preferred, 'origin']) if (name && remotes.includes(name)) return name;
  return remotes[0] ?? null;
}

/**
 * The commit to merge for a task branch: the local branch, or `<remote>/<branch>` when only the remote has it or the
 * local one is behind it. Null when neither exists.
 */
export async function taskRef(deps: CliDeps, root: string, branch: string, remote: string | null): Promise<string | null> {
  const local = (await hasRef(deps, root, `refs/heads/${branch}`)) ? `refs/heads/${branch}` : null;
  const tracking = remote && (await hasRef(deps, root, `refs/remotes/${remote}/${branch}`)) ? `refs/remotes/${remote}/${branch}` : null;
  if (!local || !tracking) return local ?? tracking;
  const behind = (await git(deps, root, ['merge-base', '--is-ancestor', local, tracking])).code === 0;
  return behind ? tracking : local;
}

/** Makes a fresh integration worktree on INTEGRATION_BRANCH at `base`, replacing a clean one left by an earlier run. */
export async function createIntegrationWorktree(deps: CliDeps, root: string, base: string): Promise<string> {
  const path = join(root, INTEGRATION_DIR);
  if (await exists(path)) {
    const status = await git(deps, path, ['status', '--porcelain', '--untracked-files=no']);
    const conflicted = (await git(deps, path, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0;
    if (status.code === 0 && status.stdout.trim() && !conflicted) {
      throw new Error(`${path} (left by an earlier merge) has uncommitted changes; remove it with: git worktree remove --force ${path}`);
    }
    await gitOk(deps, root, ['worktree', 'remove', '--force', path]);
  }
  await git(deps, root, ['worktree', 'prune']);
  const warning = await addToGitExclude(deps, root, '.agentteams/');
  if (warning) deps.err(`agentteams: warning: ${warning}`);
  await gitOk(deps, root, ['worktree', 'add', '-q', '-B', INTEGRATION_BRANCH, path, base]);
  return path;
}

export async function removeIntegrationWorktree(deps: CliDeps, root: string, path: string): Promise<void> {
  const r = await git(deps, root, ['worktree', 'remove', '--force', path]);
  if (r.code !== 0) deps.err(`agentteams: warning: could not remove ${path}: ${r.stderr.trim() || `exit ${r.code}`}`);
}

export type MergeResult = { ok: true } | { ok: false; conflicts: string[]; error: string };

/** `git merge --no-ff` of `ref` in the integration worktree. On failure the conflicted files are listed; `keep` leaves the merge in progress. */
export async function mergeRef(deps: CliDeps, wt: string, ref: string, message: string, keep = false): Promise<MergeResult> {
  const merged = await git(deps, wt, ['merge', '--no-ff', '--no-verify', '--no-edit', '-m', message, ref]);
  if (merged.code === 0) return { ok: true };
  const conflicts = lines((await git(deps, wt, ['diff', '--name-only', '--diff-filter=U'])).stdout);
  const inProgress = (await git(deps, wt, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).code === 0;
  if (inProgress && !keep) await git(deps, wt, ['merge', '--abort']);
  return { ok: false, conflicts, error: (merged.stderr.trim() || merged.stdout.trim()).split('\n')[0] ?? `exit ${merged.code}` };
}

/** Files a task branch changed since it left `base`. */
export async function changedFiles(deps: CliDeps, root: string, base: string, ref: string): Promise<string[]> {
  const r = await git(deps, root, ['diff', '--name-only', '--no-renames', `${base}...${ref}`]);
  return r.code === 0 ? lines(r.stdout) : [];
}
