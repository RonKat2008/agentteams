import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliDeps } from '../deps.js';
import { oneLine } from '../format.js';
import { gitPath, hooksPathConfigured } from '../git.js';
import { cliArgv, shellQuote } from '../paths.js';
import { PRE_COMMIT_BLOCKED } from '../exitCodes.js';
import { MANAGED_MARKER } from './hooksConfig.js';

export type GitHookName = 'pre-commit' | 'post-commit';
export interface GitHooksResult { status: 'installed' | 'unchanged' | 'skipped'; detail: string }
export interface GitHooksOptions {
  /** Path of a single executable to exec instead of node + bin. Used by tests only. */
  command?: string;
}

const HOOKS: readonly GitHookName[] = ['pre-commit', 'post-commit'];
const FILE_MARKER = '# agentteams-managed';

/** What the hook execs: node plus the CLI entry point, or (tests) a single executable. */
export type HookTarget = { node: string; bin: string } | { command: string };

const targetParts = (t: HookTarget): { argv: string; guard: string; where: string } => {
  if ('command' in t) return { argv: shellQuote(t.command), guard: `[ -x ${shellQuote(t.command)} ]`, where: t.command };
  const [node, bin] = [shellQuote(t.node), shellQuote(t.bin)];
  return { argv: `${node} ${bin}`, guard: `[ -x ${node} ] && [ -f ${bin} ]`, where: t.bin };
};

/**
 * Pure: the managed hook script. The final invocation is guarded so that a moved or deleted
 * node/CLI never blocks a commit (the script warns on stderr and exits 0). pre-commit blocks only
 * when the CLI exits 3 (its "blocked" code); any other status, such as a crash, allows the commit.
 * The injectable test `command` is a single executable path, guarded with `-x`; the default is
 * guarded on both node (`-x`) and bin (`-f`).
 */
export function managedScript(name: GitHookName, target: HookTarget): string {
  const blocking = name === 'pre-commit';
  const { argv, guard, where } = targetParts(target);
  const invoke = `${argv} git-hook ${name} ${MANAGED_MARKER}`;
  const warn = `echo ${shellQuote(oneLine(`agentteams: warning: CLI not found at ${where}; run agentteams install`))} >&2`;
  return [
    '#!/bin/sh',
    FILE_MARKER,
    `prev="$(dirname "$0")/${name}.agentteams-prev"`,
    `if [ -x "$prev" ]; then "$prev" "$@" ${blocking ? '|| exit $?' : '|| true'}; fi`,
    blocking
      ? `if ${guard}; then ${invoke}; rc=$?; [ "$rc" -eq ${PRE_COMMIT_BLOCKED} ] && exit 1; else ${warn}; fi`
      : `if ${guard}; then ${invoke} || true; else ${warn}; fi`,
    'exit 0',
    '',
  ].join('\n');
}

const oneLinePath = (p: string): string => oneLine(p);

const readOrNull = (p: string): Promise<string | null> =>
  readFile(p, 'utf8').then((s) => s, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });

export async function installGitHooks(
  deps: Pick<CliDeps, 'exec'>,
  repoPath: string,
  opts: GitHooksOptions = {},
): Promise<GitHooksResult> {
  const target: HookTarget = opts.command !== undefined
    ? { command: opts.command }
    : { node: cliArgv().command, bin: cliArgv().args[0]! };
  let dir: string;
  try {
    dir = await gitPath(deps, repoPath, 'hooks');
  } catch (err) {
    return { status: 'skipped', detail: `not a git repository (${(err as Error).message})` };
  }
  const configured = await hooksPathConfigured(deps, repoPath);
  if (configured) {
    // The two lines a user adds to their hook manager (to be documented in the README, Task 8):
    //   pre-commit:  agentteams git-hook pre-commit --agentteams-managed
    //   post-commit: agentteams git-hook post-commit --agentteams-managed || true
    return {
      status: 'skipped',
      detail: `git hooks not installed: core.hooksPath is set (${oneLinePath(configured)}); add 'agentteams git-hook pre-commit' / 'post-commit' to your hook manager — see README`,
    };
  }

  // Plan every change first so a refusal leaves nothing half-written.
  const plan: { name: GitHookName; path: string; script: string; moveExisting: boolean }[] = [];
  for (const name of HOOKS) {
    const path = join(dir, name);
    const script = managedScript(name, target);
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
  if (plan.length === 0) return { status: 'unchanged', detail: 'already installed' };

  await mkdir(dir, { recursive: true });
  for (const step of plan) {
    const prev = `${step.path}.agentteams-prev`;
    if (step.moveExisting) await rename(step.path, prev);
    try {
      await writeFile(step.path, step.script, { mode: 0o755 });
      await chmod(step.path, 0o755);
    } catch (err) {
      if (step.moveExisting) await rename(prev, step.path).catch(() => undefined); // restore the user's hook
      throw err;
    }
  }
  return { status: 'installed', detail: `installed ${plan.map((s) => s.name).join(', ')} in ${dir}` };
}
