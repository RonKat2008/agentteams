import { realpath } from 'node:fs/promises';
import { parse } from 'node:path';
import type { CliDeps } from './deps.js';

type ExecDeps = Pick<CliDeps, 'exec'>;

export async function repoRoot(deps: ExecDeps, cwd: string): Promise<string> {
  const res = await deps.exec('git', ['rev-parse', '--show-toplevel'], { cwd });
  return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : cwd;
}

export async function isGitRepo(deps: ExecDeps, cwd: string): Promise<boolean> {
  const res = await deps.exec('git', ['rev-parse', '--show-toplevel'], { cwd });
  return res.code === 0 && res.stdout.trim() !== '';
}

export const real = (p: string): Promise<string> => realpath(p).catch(() => p);

/** Refuse to set up a team in the home directory or filesystem root; warn when not in a git repo. */
export async function checkTeamDir(deps: Pick<CliDeps, 'exec' | 'homedir' | 'err'>, cwd: string): Promise<void> {
  const dir = await real(cwd);
  if (dir === (await real(deps.homedir)) || dir === parse(dir).root) {
    throw new Error(`refusing to set up a team in ${dir}; cd into a project repo first`);
  }
  if (!(await isGitRepo(deps, cwd))) {
    deps.err(`warning: ${dir} is not a git repository; the team will be tied to this directory`);
  }
}

export const FIRST_COMMIT_MESSAGE = 'chore: start agentteams team';

export type FirstCommit = 'exists' | 'committed' | 'no-identity' | { failed: string };

async function hasGitIdentity(deps: ExecDeps, cwd: string): Promise<boolean> {
  for (const key of ['user.name', 'user.email']) {
    const r = await deps.exec('git', ['config', key], { cwd });
    if (r.code !== 0 || !r.stdout.trim()) return false;
  }
  return true;
}

/**
 * Task worktrees branch from a commit, so a brand-new repo gets an empty first commit, but only when the user's
 * git identity is configured (never a made-up author).
 */
export async function ensureFirstCommit(deps: ExecDeps, cwd: string): Promise<FirstCommit> {
  if ((await deps.exec('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd })).code === 0) return 'exists';
  if (!(await hasGitIdentity(deps, cwd))) return 'no-identity';
  const r = await deps.exec('git', ['-c', 'user.useConfigOnly=true', 'commit', '-q', '--allow-empty', '-m', FIRST_COMMIT_MESSAGE], { cwd });
  if (r.code !== 0) return { failed: (r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}` };
  return 'committed';
}

/** What to tell the user about `ensureFirstCommit`; null when nothing happened. `isError` lines go to stderr. */
export function firstCommitNote(res: FirstCommit): { text: string; isError: boolean } | null {
  const commitFirst = `task worktrees need one: git commit --allow-empty -m "${FIRST_COMMIT_MESSAGE}"`;
  if (res === 'exists') return null;
  if (res === 'committed') return { text: `Made an empty first commit ("${FIRST_COMMIT_MESSAGE}") so task worktrees have a branch point.`, isError: false };
  if (res === 'no-identity') {
    return { text: `note: this repo has no commits yet and your git user.name/user.email are not set; set them, then make one (${commitFirst})`, isError: true };
  }
  return { text: `warning: this repo has no commits yet and the first commit failed (${res.failed}); ${commitFirst}`, isError: true };
}

export async function detectGithubSlug(deps: ExecDeps, cwd: string): Promise<string | null> {
  const res = await deps.exec('git', ['remote', 'get-url', 'origin'], { cwd });
  if (res.code !== 0) return null;
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(res.stdout.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
