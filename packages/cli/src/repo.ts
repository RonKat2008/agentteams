import type { CliDeps } from './deps.js';

type ExecDeps = Pick<CliDeps, 'exec'>;
const MEMBER_MAX = 24;

export async function repoRoot(deps: ExecDeps, cwd: string): Promise<string> {
  const res = await deps.exec('git', ['rev-parse', '--show-toplevel'], { cwd });
  return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : cwd;
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
