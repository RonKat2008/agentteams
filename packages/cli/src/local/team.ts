import { access } from 'node:fs/promises';
import type { CreateTeamInput, JoinTeamInput } from '@agentteams/shared';
import type { CliDeps } from '../deps.js';
import { openTeamStore, teamDbPath, type TeamStore } from './store.js';

type Deps = Pick<CliDeps, 'exec'>;

/** What create/join print instead of the hub line for a local team. */
export const LOCAL_TEAM_LABEL = 'Team: local to this computer (stored in .git/agentteams)';

/** Hub service errors (DomainError) become plain errors carrying the service's message. */
async function call<T>(store: TeamStore, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof store.core.DomainError) throw new Error(err.message);
    throw err;
  }
}

/** True when this repo (any of its worktrees) already holds a local team database. Never creates one. */
export async function hasLocalTeam(deps: Deps, cwd: string): Promise<boolean> {
  try {
    await access(await teamDbPath(deps, cwd));
    return true;
  } catch {
    return false;
  }
}

export async function createLocalTeam(deps: Deps, repoPath: string, input: CreateTeamInput) {
  const store = await openTeamStore(deps, repoPath);
  return call(store, () => store.core.createTeam(store.ctx, input));
}

export async function joinLocalTeam(deps: Deps, repoPath: string, input: JoinTeamInput) {
  const store = await openTeamStore(deps, repoPath);
  return call(store, () => store.core.joinTeam(store.ctx, input));
}

/**
 * Whether `code` is an invite for a team in this repo's local database. Unknown or malformed codes are "no" (the
 * caller then tries a hub); a code this database knows but that expired or was revoked is reported as an error.
 */
export async function localInviteMatches(deps: Deps, cwd: string, code: string): Promise<boolean> {
  if (!(await hasLocalTeam(deps, cwd))) return false;
  const store = await openTeamStore(deps, cwd);
  try {
    await store.core.previewInvite(store.ctx, { inviteCode: code });
    return true;
  } catch (err) {
    if (err instanceof store.core.DomainError && err.code === 'forbidden') throw new Error(err.message);
    if (err instanceof store.core.DomainError) return false;
    throw err;
  }
}
