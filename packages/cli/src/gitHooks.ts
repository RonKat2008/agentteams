import { RepoPath, type CheckFilesResult } from '@agentteams/shared';
import { resolveCredentialForCwd, type Credential } from './credentials.js';
import type { CliDeps } from './deps.js';
import { PRE_COMMIT_BLOCKED } from './exitCodes.js';
import { oneLine } from './format.js';
import { currentBranch, headCommit, stagedFiles } from './git.js';
import { teamClientFor, type TeamClient } from './teamClient.js';
import { orderedToolKinds } from './tools/registry.js';

export type { GitHookName } from './install/gitHooks.js';

const HOOK_TIMEOUT_MS = 2000;
const CHECK_BATCH_SIZE = 1000;

type Deps = Pick<CliDeps, 'env' | 'homedir' | 'cwd' | 'fetch' | 'exec' | 'err'>;

/** Task branches are named at/<agent>/<task> (see the worktree command). */
const TASK_BRANCH = /^at\/(.+)\/\d+$/;

/**
 * Git hooks are tool-agnostic. On a task branch (at/<agent>/<n>) the credential for that agent wins,
 * so claude and codex sharing a repo are not mistaken for each other. Otherwise (or if no credential
 * matches) fall back to a fixed order (claude, codex, then the other tools) so the choice is deterministic.
 */
async function pickCredential(deps: Deps): Promise<Credential | null> {
  const found: Credential[] = [];
  for (const tool of orderedToolKinds()) {
    const cred = await resolveCredentialForCwd(deps, deps.cwd, tool);
    if (cred) found.push(cred);
  }
  const agent = TASK_BRANCH.exec(await currentBranch(deps, deps.cwd))?.[1];
  return (agent !== undefined ? found.find((c) => c.agentName === agent) : undefined) ?? found[0] ?? null;
}

const clientFor = (deps: Deps, cred: Credential): TeamClient => teamClientFor(deps, cred, { timeoutMs: HOOK_TIMEOUT_MS });

/** Paths the hub would reject (too long, control chars, absolute, `..`) must not sink the whole check. */
const checkable = (paths: string[]): string[] => paths.filter((p) => RepoPath.safeParse(p).success);

async function checkInBatches(client: TeamClient, paths: string[]): Promise<CheckFilesResult['conflicts']> {
  const conflicts: CheckFilesResult['conflicts'] = [];
  for (let i = 0; i < paths.length; i += CHECK_BATCH_SIZE) {
    conflicts.push(...(await client.checkFiles(paths.slice(i, i + CHECK_BATCH_SIZE))).conflicts);
  }
  return conflicts;
}

const message = (e: unknown): string => oneLine(e instanceof Error ? e.message : String(e));

const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? oneLine(iso) : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export async function runPreCommit(deps: Deps): Promise<number> {
  try {
    const cred = await pickCredential(deps);
    if (!cred) return 0;
    const staged = await stagedFiles(deps, deps.cwd);
    const paths = checkable(staged);
    const skipped = staged.length - paths.length;
    if (skipped > 0) deps.err(`agentteams: warning: skipped ${skipped} path(s) that cannot be checked for claims`);
    if (paths.length === 0) return 0;
    const client = clientFor(deps, cred);
    let conflicts;
    try {
      conflicts = await checkInBatches(client, paths);
    } catch (e) {
      deps.err(`agentteams: warning: could not check file claims (${message(e)}); committing anyway`);
      return 0;
    }
    if (conflicts.length === 0) return 0;
    const owners = [...new Set(conflicts.map((c) => oneLine(c.agent)))].join(', ');
    if (deps.env.AGENTTEAMS_ALLOW === '1') {
      await client.claimOverride([...new Set(conflicts.map((c) => c.path))].slice(0, CHECK_BATCH_SIZE)).catch(() => undefined);
      deps.err(`agentteams: committing over claims held by ${owners} (AGENTTEAMS_ALLOW=1); they have been notified`);
      return 0;
    }
    deps.err([
      'agentteams: commit blocked — these staged files are claimed by other agents:',
      ...conflicts.map((c) => `  ${oneLine(c.path)}  (claimed by ${oneLine(c.agent)} via ${oneLine(c.glob)}, until ${hhmm(c.expiresAt)})`),
      'Ask them via send_message, wait for release, or override with: AGENTTEAMS_ALLOW=1 git commit ...',
    ].join('\n'));
    return PRE_COMMIT_BLOCKED;
  } catch (e) {
    deps.err(`agentteams: warning: claim check failed (${message(e)}); committing anyway`);
    return 0;
  }
}

export async function runPostCommit(deps: Deps): Promise<number> {
  try {
    const cred = await pickCredential(deps);
    if (!cred) return 0;
    const commit = await headCommit(deps, deps.cwd);
    await clientFor(deps, cred).recordCommit(commit);
  } catch (e) {
    deps.err(`agentteams: warning: could not record commit (${message(e)})`);
  }
  return 0;
}
