import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ToolKind } from '@agentteams/shared';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import type { TeamClient } from '../teamClient.js';
import { gitTopLevel, mainRepoRoot } from '../git.js';
import { getAdapter } from '../tools/registry.js';
import { installGitHooks } from '../install/gitHooks.js';
import { addToGitExclude } from '../tools/gitExclude.js';
import { clientFor, refExists, requireCredential, teamDefaultBranch } from './shared.js';

export interface WorktreeOpts { agent?: ToolKind; base?: string; remove?: boolean; force?: boolean }

/** Task worktrees live inside the repo (so sandboxed agents such as Codex can write there), git-excluded. */
export const WORKTREES_DIR = '.agentteams';

export interface TaskWorktree { root: string; path: string; branch: string }

export const UNBORN_HEAD_MESSAGE = 'has no commits yet, so there is nothing to branch task worktrees from; '
  + 'make a first commit (e.g. git commit --allow-empty -m "chore: start agentteams team") and retry';

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

const git = (deps: CliDeps, cwd: string, args: string[]) => deps.exec('git', args, { cwd });

/** True when `path` is a git worktree whose checked-out branch is `branch`. */
async function isWorktreeOn(deps: CliDeps, path: string, branch: string): Promise<boolean> {
  const top = await git(deps, path, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || top.stdout.trim() !== path) return false;
  const cur = await git(deps, path, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return cur.code === 0 && cur.stdout.trim() === branch;
}

/** `<root>/.agentteams/worktrees/<agent>/<task>`; before 0.5 worktrees were made at `<root>/../<repo>.at/<agent>-<task>`. */
const newPath = (root: string, agent: string, task: number): string => join(root, WORKTREES_DIR, 'worktrees', agent, String(task));
const legacyPath = (root: string, agent: string, task: number): string => join(dirname(root), `${basename(root)}.at`, `${agent}-${task}`);

/** Where this task's worktree is: the old location when a worktree for it already exists there, else the new one. */
async function taskWorktreePath(deps: CliDeps, root: string, agent: string, task: number, branch: string): Promise<string> {
  const legacy = legacyPath(root, agent, task);
  return (await exists(legacy)) && (await isWorktreeOn(deps, legacy, branch)) ? legacy : newPath(root, agent, task);
}

async function pickBase(deps: CliDeps, client: TeamClient, root: string, base: string | undefined): Promise<string> {
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

/** Excludes the worktrees dir via .git/info/exclude (per clone, never a tracked file), then adds the worktree. */
async function addWorktree(deps: CliDeps, client: TeamClient, root: string, path: string, branch: string, base?: string): Promise<void> {
  const warning = await addToGitExclude(deps, root, `${WORKTREES_DIR}/`);
  if (warning) deps.err(`agentteams: warning: ${warning}`);
  const hasBranch = await refExists(deps, root, `refs/heads/${branch}`);
  const args = hasBranch
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, await pickBase(deps, client, root, base)];
  const res = await git(deps, root, args);
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr.trim() || `exit ${res.code}`}`);
}

/** The untracked per-worktree agent config, plus the shared git hooks. Failures only warn. */
async function setupForAgent(deps: CliDeps, cred: Credential, root: string, path: string): Promise<void> {
  const adapter = getAdapter(cred.tool);
  if (adapter.installForWorktree) {
    const report = await adapter.installForWorktree(deps, cred, path);
    for (const w of report.warnings) deps.err(`agentteams: warning: ${w}`);
  }
  const hooks = await installGitHooks(deps, root).catch((e: unknown) => ({
    status: 'skipped' as const, detail: e instanceof Error ? e.message : String(e),
  }));
  if (hooks.status === 'skipped') deps.err(`agentteams: warning: ${hooks.detail.startsWith('git hooks') ? hooks.detail : `git hooks not installed: ${hooks.detail}`}`);
}

export async function repoRootOf(deps: CliDeps): Promise<string> {
  const root = (await mainRepoRoot(deps, deps.cwd)) ?? (await gitTopLevel(deps, deps.cwd));
  if (!root) throw new Error('not inside a git repository');
  return root;
}

/** Claims `task` as `cred`'s agent and makes sure its branch, worktree and per-worktree agent config exist. */
export async function ensureTaskWorktree(deps: CliDeps, cred: Credential, task: number, base?: string): Promise<TaskWorktree> {
  const root = await repoRootOf(deps);
  const branch = `at/${cred.agentName}/${task}`;
  const path = await taskWorktreePath(deps, root, cred.agentName, task, branch);
  const present = await exists(path);
  if (present && !(await isWorktreeOn(deps, path, branch))) throw new Error(`${path} exists and is not this task's worktree`);
  if (!present && !(await refExists(deps, root, 'HEAD'))) throw new Error(`${root} ${UNBORN_HEAD_MESSAGE}`);

  const client = clientFor(deps, cred);
  await client.claimTask(task);
  if (present) deps.out(`worktree already exists: ${path}`);
  else await addWorktree(deps, client, root, path, branch, base);
  await setupForAgent(deps, cred, root, path);
  return { root, path, branch };
}

export async function worktreeCommand(deps: CliDeps, task: number, opts: WorktreeOpts): Promise<void> {
  const cred = await requireCredential(deps, opts.agent);
  if (opts.remove) {
    const root = await repoRootOf(deps);
    const branch = `at/${cred.agentName}/${task}`;
    const path = await taskWorktreePath(deps, root, cred.agentName, task, branch);
    return removeWorktree(deps, task, root, branch, path, Boolean(opts.force));
  }
  const { path, branch } = await ensureTaskWorktree(deps, cred, task, opts.base);
  deps.out(`Task #${task} claimed. Worktree: ${path} (branch ${branch})`);
  deps.out(`Next: cd ${path} && ${getAdapter(cred.tool).launch}`);
}
