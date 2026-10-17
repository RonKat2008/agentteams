import { chmod, mkdir, open as openFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
/** Process-wide wait for another process's write lock (undefined = the hub default, 5 s). */
let lockWaitMs: number | undefined;

/**
 * Caps how long this process waits for another process's SQLite write lock, for stores opened from now on and
 * stores already open. Hooks set a short wait: a long sync apply makes them give up (SQLITE_BUSY, nothing
 * delivered this time) instead of blocking the agent for seconds.
 */
export async function setStoreLockWait(ms: number): Promise<void> {
  const value = Math.max(0, Math.trunc(ms));
  lockWaitMs = value;
  for (const pending of stores.values()) {
    const store = await pending.catch(() => null);
    if (store) await store.core.sql.raw(`pragma busy_timeout = ${value}`).execute(store.ctx.db);
  }
}

const dbPaths = new Map<string, Promise<string>>();
const SIDECARS = ['-wal', '-shm'];

async function resolveDbPath(deps: Deps, repoPath: string): Promise<string> {
  // Plain --git-common-dir (relative to cwd on older git, absolute otherwise); resolve it ourselves.
  const r = await deps.exec('git', ['rev-parse', '--git-common-dir'], { cwd: repoPath });
  const common = r.stdout.trim();
  if (r.code !== 0 || !common) throw new Error(`not a git repository: ${repoPath}`);
  return join(isAbsolute(common) ? common : resolve(repoPath, common), 'agentteams', 'team.db');
}

/** `<abs git-common-dir>/agentteams/team.db`; a linked worktree resolves to the main repo's database. Cached per repoPath. */
export function teamDbPath(deps: Deps, repoPath: string): Promise<string> {
  let p = dbPaths.get(repoPath);
  if (!p) {
    p = resolveDbPath(deps, repoPath);
    dbPaths.set(repoPath, p);
    p.catch(() => dbPaths.delete(repoPath));
  }
  return p;
}

/** Create the file private before SQLite touches it, so it is never briefly world-readable. */
async function ensurePrivateFile(path: string): Promise<void> {
  const fh = await openFile(path, 'a', STORE_FILE_MODE);
  await fh.close();
  await chmod(path, STORE_FILE_MODE);
}

async function open(path: string): Promise<TeamStore> {
  // Lazy: only local-transport credentials pay for kysely + better-sqlite3.
  const core = await import('@agentteams/hub/core');
  await mkdir(dirname(path), { recursive: true, mode: STORE_DIR_MODE });
  await chmod(dirname(path), STORE_DIR_MODE);
  await ensurePrivateFile(path);
  const db = core.createSqliteDb(path, lockWaitMs === undefined ? {} : { busyTimeoutMs: lockWaitMs });
  await core.migrateToLatest(db);
  // WAL sidecars appear once SQLite writes; tighten whichever exist (the 0700 directory covers the rest).
  for (const suffix of SIDECARS) await chmod(path + suffix, STORE_FILE_MODE).catch(() => undefined);
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
