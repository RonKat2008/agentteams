import { dirname, resolve } from 'node:path';
import type { CliDeps } from './deps.js';

type Deps = Pick<CliDeps, 'exec'>;

const MAX_MESSAGE_CHARS = 2000;
const MAX_FILES = 1000;

async function git(deps: Deps, cwd: string, args: string[]) {
  return deps.exec('git', args, { cwd });
}

export async function gitTopLevel(deps: Deps, cwd: string): Promise<string | null> {
  const r = await git(deps, cwd, ['rev-parse', '--show-toplevel']);
  const out = r.stdout.trim();
  return r.code === 0 && out ? out : null;
}

/** Root of the main working tree (also when called from a linked worktree); null for bare or non-repos. */
export async function mainRepoRoot(deps: Deps, cwd: string): Promise<string | null> {
  const r = await git(deps, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const common = r.stdout.trim();
  if (r.code !== 0 || !common) return null;
  return common.endsWith('/.git') ? dirname(common) : null;
}

/** Absolute path of a git-dir file (shared across worktrees for info/*). Falls back for git older than 2.31. */
export async function gitPath(deps: Deps, cwd: string, name: string): Promise<string> {
  let r = await git(deps, cwd, ['rev-parse', '--path-format=absolute', '--git-path', name]);
  if (r.code !== 0) r = await git(deps, cwd, ['rev-parse', '--git-path', name]); // no --path-format: relative to cwd
  const out = r.stdout.trim();
  if (r.code !== 0 || !out) throw new Error(`git rev-parse --git-path ${name} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return resolve(cwd, out);
}

/** Whether `relPath` is tracked by git (an ignore rule cannot hide a tracked file). */
export async function isTracked(deps: Deps, cwd: string, relPath: string): Promise<boolean> {
  return (await git(deps, cwd, ['ls-files', '--error-unmatch', '--', relPath])).code === 0;
}

export async function currentBranch(deps: Deps, cwd: string): Promise<string> {
  const r = await git(deps, cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const out = r.stdout.trim();
  return r.code === 0 && out ? out : 'HEAD';
}

export async function stagedFiles(deps: Deps, cwd: string): Promise<string[]> {
  const r = await git(deps, cwd, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--diff-filter=ACMRD']);
  if (r.code !== 0) return [];
  return r.stdout.split('\0').filter((f) => f !== '');
}

export interface HeadCommit { sha: string; branch: string; message: string; files: string[]; insertions: number; deletions: number }

const count = (s: string): number => (s === '-' ? 0 : Number.parseInt(s, 10) || 0);

export async function headCommit(deps: Deps, cwd: string): Promise<HeadCommit> {
  const log = await git(deps, cwd, ['log', '-1', '--format=%H%x00%B']);
  if (log.code !== 0) throw new Error(`git log failed: ${log.stderr.trim() || `exit ${log.code}`}`);
  const sep = log.stdout.indexOf('\0');
  const sha = log.stdout.slice(0, sep).trim();
  const message = log.stdout.slice(sep + 1).trim().slice(0, MAX_MESSAGE_CHARS);

  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  const show = await git(deps, cwd, ['show', '--numstat', '--format=', '--no-renames', '-z', 'HEAD']);
  if (show.code === 0) {
    for (const rec of show.stdout.split('\0')) {
      const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(rec.replace(/^\n+/, ''));
      if (!m) continue;
      insertions += count(m[1]!);
      deletions += count(m[2]!);
      if (files.length < MAX_FILES) files.push(m[3]!);
    }
  }
  return { sha, branch: await currentBranch(deps, cwd), message, files, insertions, deletions };
}

export async function defaultBranch(deps: Deps, cwd: string, slug?: string): Promise<string> {
  const head = await git(deps, cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const fromOrigin = head.stdout.trim().replace(/^origin\//, '');
  if (head.code === 0 && fromOrigin) return fromOrigin;
  if (slug) {
    const gh = await deps.exec('gh', ['repo', 'view', slug, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], { cwd });
    const name = gh.stdout.trim();
    if (gh.code === 0 && name) return name;
  }
  const cur = await git(deps, cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = cur.stdout.trim();
  return cur.code === 0 && branch ? branch : 'main';
}

export async function hooksPathConfigured(deps: Deps, cwd: string): Promise<string | null> {
  const r = await git(deps, cwd, ['config', '--get', 'core.hooksPath']);
  const out = r.stdout.trim();
  return r.code === 0 && out ? out : null;
}
