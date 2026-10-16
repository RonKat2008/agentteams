import { chmod, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CliDeps } from '../deps.js';

type Deps = Pick<CliDeps, 'exec'>;
type Core = typeof import('@agentteams/hub/core');

export interface TeamStore {
  readonly path: string;
  readonly core: Core;
  readonly ctx: import('@agentteams/hub/core').HubContext;
}

const STORE_DIR_MODE = 0o700;
const STORE_FILE_MODE = 0o600;
const stores = new Map<string, Promise<TeamStore>>();

/** `<abs git-common-dir>/agentteams/team.db`; a linked worktree resolves to the main repo's database. */
export async function teamDbPath(deps: Deps, repoPath: string): Promise<string> {
  const r = await deps.exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoPath });
  const common = r.stdout.trim();
  if (r.code !== 0 || !common) throw new Error(`not a git repository: ${repoPath}`);
  return join(common, 'agentteams', 'team.db');
}

async function open(path: string): Promise<TeamStore> {
  // Lazy: only local-transport credentials pay for kysely + better-sqlite3.
  const core = await import('@agentteams/hub/core');
  await mkdir(dirname(path), { recursive: true, mode: STORE_DIR_MODE });
  await chmod(dirname(path), STORE_DIR_MODE);
  const db = core.createSqliteDb(path);
  await chmod(path, STORE_FILE_MODE);
  await core.migrateToLatest(db);
  return { path, core, ctx: core.createContext(db, { mode: 'local' }) };
}

/** Opens (creating and migrating if needed) the repo's team database; cached per process per path. */
export async function openTeamStore(deps: Deps, repoPath: string): Promise<TeamStore> {
  const path = await teamDbPath(deps, repoPath);
  let store = stores.get(path);
  if (!store) {
    store = open(path);
    stores.set(path, store);
    store.catch(() => stores.delete(path));
  }
  return store;
}
