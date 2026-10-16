import { realpath } from 'node:fs/promises';
import { parse } from 'node:path';
import type { CliDeps } from './deps.js';

type ExecDeps = Pick<CliDeps, 'exec'>;
const MEMBER_MAX = 24;

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

export async function detectGithubSlug(deps: ExecDeps, cwd: string): Promise<string | null> {
  const res = await deps.exec('git', ['remote', 'get-url', 'origin'], { cwd });
  if (res.code !== 0) return null;
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(res.stdout.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export function defaultMemberName(username: string): string {
  const cleaned = username.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, MEMBER_MAX);
  return cleaned || 'user';
}
