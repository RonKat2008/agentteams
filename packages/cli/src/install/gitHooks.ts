import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliDeps } from '../deps.js';
import { gitPath, hooksPathConfigured } from '../git.js';
import { cliCommand } from '../paths.js';
import { MANAGED_MARKER } from './hooksConfig.js';

export type GitHookName = 'pre-commit' | 'post-commit';
export interface GitHooksResult { status: 'installed' | 'unchanged' | 'skipped'; detail: string }
export interface GitHooksOptions {
  /** Shell fragment that re-invokes the CLI (default: quoted node + bin). Overridden by tests only. */
  command?: string;
}

const HOOKS: readonly GitHookName[] = ['pre-commit', 'post-commit'];
const FILE_MARKER = '# agentteams-managed';

/** Pure: the managed hook script. `cli` is e.g. `'<node>' '<bin>'`. */
export function managedScript(name: GitHookName, cli: string): string {
  const blocking = name === 'pre-commit';
  const prevTail = blocking ? '|| exit $?' : '|| true';
  const lastTail = blocking ? '' : ' || true';
  return [
    '#!/bin/sh',
    FILE_MARKER,
    `prev="$(dirname "$0")/${name}.agentteams-prev"`,
    `if [ -x "$prev" ]; then "$prev" "$@" ${prevTail}; fi`,
    `${blocking ? 'exec ' : ''}${cli} git-hook ${name} ${MANAGED_MARKER}${lastTail}`,
    '',
  ].join('\n');
}

const readOrNull = (p: string): Promise<string | null> =>
  readFile(p, 'utf8').then((s) => s, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });

export async function installGitHooks(
  deps: Pick<CliDeps, 'exec'>,
  repoPath: string,
  opts: GitHooksOptions = {},
): Promise<GitHooksResult> {
  const cli = opts.command ?? cliCommand();
  let dir: string;
  try {
    dir = await gitPath(deps, repoPath, 'hooks');
  } catch (err) {
    return { status: 'skipped', detail: `not a git repository (${(err as Error).message})` };
  }
  const configured = await hooksPathConfigured(deps, repoPath);
  if (configured) {
    const lines = HOOKS.map((h) => `  ${h}: ${cli} git-hook ${h} ${MANAGED_MARKER}`);
    return {
      status: 'skipped',
      detail: `core.hooksPath is set (${configured}); add these lines to your own hooks:\n${lines.join('\n')}`,
    };
  }

  // Plan every change first so a refusal leaves nothing half-written.
  const plan: { name: GitHookName; path: string; script: string; moveExisting: boolean }[] = [];
  for (const name of HOOKS) {
    const path = join(dir, name);
    const script = managedScript(name, cli);
    const existing = await readOrNull(path);
    if (existing === script) continue;
    let moveExisting = false;
    if (existing !== null && !existing.includes(FILE_MARKER)) {
      if ((await readOrNull(`${path}.agentteams-prev`)) !== null) {
        return { status: 'skipped', detail: `${name} and ${name}.agentteams-prev both exist; merge them manually` };
      }
      moveExisting = true;
    }
    plan.push({ name, path, script, moveExisting });
  }
  if (plan.length === 0) return { status: 'unchanged', detail: 'git hooks already installed' };

  await mkdir(dir, { recursive: true });
  for (const step of plan) {
    if (step.moveExisting) await rename(step.path, `${step.path}.agentteams-prev`);
    await writeFile(step.path, step.script, { mode: 0o755 });
    await chmod(step.path, 0o755);
  }
  return { status: 'installed', detail: `installed ${plan.map((s) => s.name).join(', ')} in ${dir}` };
}
