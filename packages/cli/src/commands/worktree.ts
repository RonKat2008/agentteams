import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ToolKind } from '@agentteams/shared';
import type { CliDeps } from '../deps.js';
import type { HubClient } from '../hubClient.js';
import { gitTopLevel, mainRepoRoot } from '../git.js';
import { getAdapter } from '../tools/registry.js';
import { installGitHooks } from '../install/gitHooks.js';
import { clientFor, refExists, requireCredential, teamDefaultBranch } from './shared.js';

export interface WorktreeOpts { agent?: ToolKind; base?: string; remove?: boolean; force?: boolean }

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

const git = (deps: CliDeps, cwd: string, args: string[]) => deps.exec('git', args, { cwd });

/** True when `path` is a git worktree whose checked-out branch is `branch`. */
async function isWorktreeOn(deps: CliDeps, path: string, branch: string): Promise<boolean> {
  const top = await git(deps, path, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || top.stdout.trim() !== path) return false;
  const cur = await git(deps, path, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return cur.code === 0 && cur.stdout.trim() === branch;
}

async function pickBase(deps: CliDeps, client: HubClient, root: string, base: string | undefined): Promise<string> {
  if (base) return base;
  const { branch: d, provider } = await teamDefaultBranch(deps, client, root);
  if (provider !== 'github') return d;
  const fetched = await git(deps, root, ['fetch', 'origin', d]);
  if (fetched.code === 0) return `origin/${d}`;
  deps.err(`agentteams: warning: git fetch origin ${d} failed; using local ${d}`);
  return d;
}

/** Removes this task's worktree (the branch is kept). Refuses uncommitted changes unless `force`. */
async function removeWorktree(deps: CliDeps, task: number, root: string, branch: string, path: string, force: boolean): Promise<void> {
  if (!(await exists(path))) throw new Error(`no worktree for task #${task} at ${path}`);
  if (!(await isWorktreeOn(deps, path, branch))) throw new Error(`${path} exists and is not this task's worktree`);
  if (!force) {
    const status = await git(deps, path, ['status', '--porcelain']);
    if (status.code !== 0) throw new Error(`git status failed in ${path}: ${status.stderr.trim() || `exit ${status.code}`}`);
    if (status.stdout.trim()) {
      throw new Error(`${path} has uncommitted changes; commit or stash them, or re-run with --force to discard them`);
    }
  }
  const args = ['worktree', 'remove', ...(force ? ['--force'] : []), path];
  const res = await git(deps, root, args);
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  deps.out(`Removed worktree ${path} (branch ${branch} kept)`);
}

export async function worktreeCommand(deps: CliDeps, task: number, opts: WorktreeOpts): Promise<void> {
  const cred = await requireCredential(deps, opts.agent);
  const root = (await mainRepoRoot(deps, deps.cwd)) ?? (await gitTopLevel(deps, deps.cwd));
  if (!root) throw new Error('not inside a git repository');

  const branch = `at/${cred.agentName}/${task}`;
  const path = join(dirname(root), `${basename(root)}.at`, `${cred.agentName}-${task}`);
  if (opts.remove) return removeWorktree(deps, task, root, branch, path, Boolean(opts.force));

  const client = clientFor(deps, cred);
  await client.claimTask(task);

  if (await exists(path)) {
    if (!(await isWorktreeOn(deps, path, branch))) throw new Error(`${path} exists and is not this task's worktree`);
    deps.out(`worktree already exists: ${path}`);
  } else {
    const hasBranch = await refExists(deps, root, `refs/heads/${branch}`);
    const args = hasBranch
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', '-b', branch, path, await pickBase(deps, client, root, opts.base)];
    const res = await git(deps, root, args);
    if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }

  const adapter = getAdapter(cred.tool);
  if (adapter.installForWorktree) {
    const report = await adapter.installForWorktree(deps, cred, path);
    for (const w of report.warnings) deps.err(`agentteams: warning: ${w}`);
  }

  const hooks = await installGitHooks(deps, root).catch((e: unknown) => ({
    status: 'skipped' as const, detail: e instanceof Error ? e.message : String(e),
  }));
  if (hooks.status === 'skipped') deps.err(`agentteams: warning: ${hooks.detail.startsWith('git hooks') ? hooks.detail : `git hooks not installed: ${hooks.detail}`}`);

  deps.out(`Task #${task} claimed. Worktree: ${path} (branch ${branch})`);
  deps.out(`Next: cd ${path} && ${cred.tool === 'codex' ? 'codex' : 'claude'}`);
}
