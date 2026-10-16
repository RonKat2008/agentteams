/**
 * Light-weight sync bookkeeping for git teams: file locations, the round status file, the sync lock, the
 * error log, the once-per-error hook warning and the detached spawn. Only node built-ins: hooks import this.
 *
 * Everything lives in `<git-common-dir>/agentteams/` next to team.db:
 *   sync.lock         one round at a time (O_EXCL; stale after 30 s without a heartbeat)
 *   sync.log          errors, one line each
 *   sync-status.json  lastFetchAt / lastPushAt / lastAttemptAt / lastError / lastPresenceAt
 *   sync-warned       the last error already shown in a hook (so it is shown once)
 *   replica/<team>/   the op log state (sync.ts / store.ts in this directory)
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ToolKind } from '@agentteams/shared';
import type { CliDeps } from '../deps.js';
import { teamDbPath } from '../local/store.js';
import { binPath } from '../paths.js';

type Deps = Pick<CliDeps, 'exec'>;

export const LOCK_STALE_MS = 30_000;
/** Reads trigger a background fetch when the last successful one is older than this. */
export const FETCH_STALE_MS = 10_000;
const LOG_MAX_BYTES = 512 * 1024;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface SyncPaths {
  dir: string;
  lock: string;
  log: string;
  status: string;
  warned: string;
}

/** `<git-common-dir>/agentteams` and the sync files in it (resolved through the cached team.db path). */
export async function syncPaths(deps: Deps, repo: string): Promise<SyncPaths> {
  const dir = dirname(await teamDbPath(deps, repo));
  return {
    dir,
    lock: join(dir, 'sync.lock'),
    log: join(dir, 'sync.log'),
    status: join(dir, 'sync-status.json'),
    warned: join(dir, 'sync-warned'),
  };
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
}

// ---- Status ---------------------------------------------------------------------------------------

export interface SyncStatus {
  lastAttemptAt?: string;
  lastFetchAt?: string;
  lastPushAt?: string;
  lastPresenceAt?: string;
  /** Short reason of the last failed round; null after a clean round. */
  lastError?: string | null;
  lastErrorAt?: string;
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const v: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Atomic, durable write: temp file, fsync, rename. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w', FILE_MODE);
  try {
    await fh.writeFile(`${JSON.stringify(value)}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

export const readStatus = (paths: SyncPaths): Promise<SyncStatus> => readJson<SyncStatus>(paths.status, {});
export const writeStatus = (paths: SyncPaths, s: SyncStatus): Promise<void> => writeJsonAtomic(paths.status, s);

/** "last synced 12s ago" / "never synced" from the last successful fetch. */
export function lastSyncedText(status: SyncStatus, now: number = Date.now()): string {
  const at = status.lastFetchAt ? Date.parse(status.lastFetchAt) : NaN;
  if (Number.isNaN(at)) return 'never synced with the team remote';
  const s = Math.max(0, Math.round((now - at) / 1000));
  const ago = s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
  return `last synced ${ago} ago`;
}

/** The line `status` / `log` print for a git team (also the last error, when the last round failed). */
export async function syncSummaryLine(deps: Deps, repo: string, now: number = Date.now()): Promise<string> {
  const status = await readStatus(await syncPaths(deps, repo));
  const err = status.lastError ? ` (last sync failed: ${status.lastError})` : '';
  return `${lastSyncedText(status, now)}${err}`;
}

// ---- Lock -----------------------------------------------------------------------------------------

export interface SyncLock {
  /** Refreshes the lock's mtime so a long round is not considered stale. */
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

async function tryCreate(path: string, token: string): Promise<boolean> {
  try {
    const fh = await open(path, 'wx', FILE_MODE);
    try { await fh.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`); } finally { await fh.close(); }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** True when the lock file exists and was refreshed within LOCK_STALE_MS. */
export async function isLockHeld(path: string, now: number = Date.now()): Promise<boolean> {
  try {
    return now - (await stat(path)).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Takes the sync lock (O_EXCL). A lock not refreshed for LOCK_STALE_MS is broken. Returns null when another
 * live round holds it and `waitMs` elapses (0 = do not wait).
 */
export async function acquireLock(path: string, opts: { waitMs?: number; pollMs?: number; now?: () => number } = {}): Promise<SyncLock | null> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.waitMs ?? 0);
  const token = randomBytes(8).toString('hex');
  await ensureDir(dirname(path));
  for (;;) {
    if (await tryCreate(path, token)) break;
    if (!(await isLockHeld(path, now()))) {
      await unlink(path).catch(() => undefined); // stale: break it, then race for it again
      if (await tryCreate(path, token)) break;
    }
    if (now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 200));
  }
  const ours = async (): Promise<boolean> => (await readFile(path, 'utf8').catch(() => '')).includes(token);
  return {
    async heartbeat() {
      if (await ours()) { const t = new Date(); await utimes(path, t, t).catch(() => undefined); }
    },
    async release() {
      if (await ours()) await unlink(path).catch(() => undefined);
    },
  };
}

// ---- Errors: log file and the once-per-error hook warning -----------------------------------------

export async function logSyncError(paths: SyncPaths, message: string, now: number = Date.now()): Promise<void> {
  await ensureDir(paths.dir);
  try {
    if ((await stat(paths.log)).size > LOG_MAX_BYTES) await rename(paths.log, `${paths.log}.1`);
  } catch { /* no log yet */ }
  await appendFile(paths.log, `${new Date(now).toISOString()} ${message.replace(/[\r\n]+/g, ' ')}\n`, { mode: FILE_MODE });
}

const oneLine = (s: string, max = 160): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The warning a hook should show for the last failed sync, or null. Each distinct error is returned once:
 * the caller shows it and it is remembered in sync-warned.
 */
export async function takeSyncWarning(deps: Deps, repo: string): Promise<string | null> {
  const paths = await syncPaths(deps, repo);
  const status = await readStatus(paths);
  if (!status.lastError) return null;
  const warned = await readFile(paths.warned, 'utf8').catch(() => '');
  if (warned === status.lastError) return null;
  await writeFile(paths.warned, status.lastError, { mode: FILE_MODE });
  return `agentteams: sync failed: ${oneLine(status.lastError)} (see .git/agentteams/sync.log)`;
}

// ---- Detached spawn -------------------------------------------------------------------------------

export type SyncTrigger = () => void;

/**
 * Starts `agentteams sync --repo <repo> --tool <tool> --quiet` in the background: detached, no stdio,
 * unref'd, never awaited. Failures to spawn are ignored (the next trigger tries again).
 */
export function spawnDetachedSync(repo: string, tool: ToolKind, entry: string = binPath()): void {
  try {
    const child = spawn(process.execPath, [entry, 'sync', '--repo', repo, '--tool', tool, '--quiet'], {
      detached: true, stdio: 'ignore', cwd: repo,
    });
    child.on('error', () => undefined);
    child.unref();
  } catch { /* never let a background sync break the caller */ }
}

/**
 * Read-path trigger: spawn only when the last fetch is stale, no round is running and no round was attempted
 * in the last FETCH_STALE_MS (so an unreachable remote does not get one process per hook).
 */
export async function shouldSyncForRead(deps: Deps, repo: string, now: number = Date.now()): Promise<boolean> {
  const paths = await syncPaths(deps, repo);
  const status = await readStatus(paths);
  const age = (iso?: string) => (iso ? now - Date.parse(iso) : Infinity);
  if (!(age(status.lastFetchAt) > FETCH_STALE_MS)) return false;
  if (age(status.lastAttemptAt) <= FETCH_STALE_MS) return false;
  return !(await isLockHeld(paths.lock, now));
}
