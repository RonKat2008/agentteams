/**
 * Light-weight sync bookkeeping for git teams: file locations, the round status file, the sync lock, the
 * error log, the once-per-problem hook warnings, the coalescing marker and the detached spawn. Only node
 * built-ins: hooks import this.
 *
 * Everything lives in `<git-common-dir>/agentteams/` next to team.db:
 *   sync.lock         one round at a time: {pid, token}; O_EXCL create; stale after 30 s without a heartbeat
 *   sync.pending      "run another round": left by a detached sync that found the lock held (coalescing)
 *   sync.log          errors and refusals, one line each
 *   sync-status.json  lastFetchAt / lastPushAt / lastAttemptAt / lastError / refusals
 *   sync-warned       which error / refusals a hook has already shown
 *   replica/<team>/   the op log state (replicaStore.ts)
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, link, mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ToolKind } from '@agentteams/shared';
import type { CliDeps } from '../deps.js';
import { teamDbPath } from '../local/store.js';
import { binPath } from '../paths.js';

type Deps = Pick<CliDeps, 'exec'>;

export const LOCK_STALE_MS = 30_000;
export const LOCK_HEARTBEAT_MS = 5_000;
/** Reads trigger a background fetch when the last successful one is older than this. */
export const FETCH_STALE_MS = 10_000;
const LOG_MAX_BYTES = 512 * 1024;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const WARNING_DETAIL_MAX = 200;
/** Refusals kept in the status file (newest last). */
const MAX_REFUSALS = 20;

export interface SyncPaths {
  dir: string;
  lock: string;
  pending: string;
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
    pending: join(dir, 'sync.pending'),
    log: join(dir, 'sync.log'),
    status: join(dir, 'sync-status.json'),
    warned: join(dir, 'sync-warned'),
  };
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
}

/** Flattens text to one line and truncates it (git stderr can carry `remote:` lines from the server). */
// Control, zero-width, bidi and line/paragraph separator characters.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g;

export function oneLine(s: string, max = WARNING_DETAIL_MAX): string {
  const flat = s.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** How a git failure is reported: labelled as git's (untrusted) text, one line, at most 200 characters. */
export const fromGit = (what: string, stderr: string | undefined): string => `${what} (from git): ${oneLine(stderr ?? 'failed')}`;

// ---- Status ---------------------------------------------------------------------------------------

export interface SyncStatus {
  lastAttemptAt?: string;
  lastFetchAt?: string;
  lastPushAt?: string;
  lastPresenceAt?: string;
  /** Short reason of the last failed round; null after a clean round. */
  lastError?: string | null;
  lastErrorAt?: string;
  /** Security refusals (rewrites, gaps, bad segments, pin mismatches, vandalism), deduplicated, newest last. */
  refusals?: string[];
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const v: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/** fsync a directory so a create/rename in it survives power loss (best effort where unsupported). */
export async function syncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, 'r');
    try { await fh.sync(); } finally { await fh.close(); }
  } catch { /* some platforms cannot fsync a directory */ }
}

/** Atomic, durable write: temp file, fsync, rename, fsync the directory. */
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
  await syncDir(dirname(path));
}

export const readStatus = (paths: SyncPaths): Promise<SyncStatus> => readJson<SyncStatus>(paths.status, {});
export const writeStatus = (paths: SyncPaths, s: SyncStatus): Promise<void> => writeJsonAtomic(paths.status, s);

/** Adds refusals to the status (deduplicated, capped). */
export function withRefusals(status: SyncStatus, refusals: string[]): SyncStatus {
  if (refusals.length === 0) return status;
  const merged = [...(status.refusals ?? []).filter((r) => !refusals.includes(r)), ...refusals];
  return { ...status, refusals: merged.slice(-MAX_REFUSALS) };
}

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
  const err = status.lastError ? ` (last sync failed: ${oneLine(status.lastError)})` : '';
  return `${lastSyncedText(status, now)}${err}`;
}

// ---- Lock -----------------------------------------------------------------------------------------

export class LostLockError extends Error {
  constructor() {
    super('the sync lock was taken over by another round; this round stopped');
    this.name = 'LostLockError';
  }
}

export interface SyncLock {
  /** Throws LostLockError unless the lock file still carries this round's token. Call before every write phase. */
  assertOwned(): Promise<void>;
  /** Stops the heartbeat and removes the lock if (and only if) it is still ours. */
  release(): Promise<void>;
}

interface LockBody { pid: number; token: string }

async function tryCreate(path: string, body: LockBody): Promise<boolean> {
  try {
    const fh = await open(path, 'wx', FILE_MODE);
    try { await fh.writeFile(`${JSON.stringify(body)}\n`); } finally { await fh.close(); }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

const tokenOf = async (path: string): Promise<string | null> => {
  try {
    return (JSON.parse(await readFile(path, 'utf8')) as Partial<LockBody>).token ?? null;
  } catch {
    return null;
  }
};

/** True when the lock file exists and was refreshed within LOCK_STALE_MS. */
export async function isLockHeld(path: string, now: number = Date.now()): Promise<boolean> {
  try {
    return now - (await stat(path)).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Breaks a stale lock without ever deleting a live one: the lock is renamed to a unique name (atomic; only one
 * breaker wins), then re-checked there. If what was moved is not stale (someone re-created the lock between our
 * check and the rename), it is put back with link() (which fails rather than overwrite a newer lock).
 */
async function breakStale(path: string, now: number): Promise<void> {
  const aside = `${path}.break.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    await rename(path, aside);
  } catch {
    return; // gone already, or another breaker moved it
  }
  let stale = false;
  try {
    stale = now - (await stat(aside)).mtimeMs >= LOCK_STALE_MS;
  } catch { /* vanished */ }
  if (!stale) await link(aside, path).catch(() => undefined);
  await unlink(aside).catch(() => undefined);
}

/**
 * Takes the sync lock. A lock not refreshed for LOCK_STALE_MS is broken (see breakStale). Returns null when a
 * live round holds it and `waitMs` elapses (0 = do not wait). While held, a timer refreshes the lock's mtime
 * every LOCK_HEARTBEAT_MS, for the whole round.
 */
export async function acquireLock(path: string, opts: { waitMs?: number; pollMs?: number } = {}): Promise<SyncLock | null> {
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const body: LockBody = { pid: process.pid, token: randomBytes(16).toString('hex') };
  await ensureDir(dirname(path));
  for (;;) {
    if (await tryCreate(path, body)) break;
    if (!(await isLockHeld(path, Date.now()))) {
      await breakStale(path, Date.now());
      continue;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 100));
  }
  const ours = async () => (await tokenOf(path)) === body.token;
  const timer = setInterval(() => {
    void (async () => {
      if (await ours()) { const t = new Date(); await utimes(path, t, t).catch(() => undefined); }
    })();
  }, LOCK_HEARTBEAT_MS);
  timer.unref();
  return {
    async assertOwned() {
      if (!(await ours())) throw new LostLockError();
    },
    async release() {
      clearInterval(timer);
      // Move it aside first so we never unlink a lock that someone else created in the meantime.
      if (!(await ours())) return;
      const aside = `${path}.release.${body.token}`;
      try {
        await rename(path, aside);
      } catch {
        return;
      }
      if ((await tokenOf(aside)) !== body.token) await link(aside, path).catch(() => undefined);
      await unlink(aside).catch(() => undefined);
    },
  };
}

// ---- Coalescing -----------------------------------------------------------------------------------

/** Leaves "please run another round" for the round holding the lock. */
export async function markSyncWanted(paths: SyncPaths): Promise<void> {
  await ensureDir(paths.dir);
  await writeFile(paths.pending, `${Date.now()}\n`, { mode: FILE_MODE });
}

/** Consumes the marker; true if it was there. */
export async function takeSyncWanted(paths: SyncPaths): Promise<boolean> {
  try {
    await unlink(paths.pending);
    return true;
  } catch {
    return false;
  }
}

// ---- Errors: log file and the once-per-problem hook warnings --------------------------------------

export async function logSyncError(paths: SyncPaths, message: string, now: number = Date.now()): Promise<void> {
  await ensureDir(paths.dir);
  try {
    if ((await stat(paths.log)).size > LOG_MAX_BYTES) await rename(paths.log, `${paths.log}.1`);
  } catch { /* no log yet */ }
  await appendFile(paths.log, `${new Date(now).toISOString()} ${message.replace(/[\r\n]+/g, ' ')}\n`, { mode: FILE_MODE });
}

interface Warned { error?: string | null; refusals?: string[] }

/** After a clean round the error warning is re-armed, so a recurrence is shown again. Refusals stay shown-once. */
export async function clearErrorWarning(paths: SyncPaths): Promise<void> {
  const w = await readJson<Warned>(paths.warned, {});
  if (w.error) await writeJsonAtomic(paths.warned, { ...w, error: null });
}

/**
 * Warning lines a hook should show, or []: the last failed sync (once per distinct error) and each new security
 * refusal (once each). Shown lines are remembered in sync-warned.
 */
export async function takeSyncWarnings(deps: Deps, repo: string): Promise<string[]> {
  const paths = await syncPaths(deps, repo);
  const status = await readStatus(paths);
  const warned = await readJson<Warned>(paths.warned, {});
  const lines: string[] = [];
  const next: Warned = { ...warned };
  if (status.lastError && warned.error !== status.lastError) {
    lines.push(`agentteams: sync failed: ${oneLine(status.lastError)} (see ${paths.log})`);
    next.error = status.lastError;
  }
  const shown = new Set(warned.refusals ?? []);
  const fresh = (status.refusals ?? []).filter((r) => !shown.has(r));
  if (fresh.length > 0) {
    const more = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
    lines.push(`agentteams: security: refused team data: ${oneLine(fresh[fresh.length - 1]!)}${more} (see ${paths.log})`);
    next.refusals = [...shown, ...fresh].slice(-MAX_REFUSALS * 2);
  }
  if (lines.length > 0) await writeJsonAtomic(paths.warned, next);
  return lines;
}

/** All warning lines joined into one block, or null when there is none. */
export async function takeSyncWarning(deps: Deps, repo: string): Promise<string | null> {
  return (await takeSyncWarnings(deps, repo)).join('\n') || null;
}

// ---- Detached spawn -------------------------------------------------------------------------------

export type SyncTrigger = () => void;

/**
 * Starts `agentteams sync --repo <repo> --tool <tool> --quiet` in the background: detached, no stdio,
 * unref'd, never awaited. Failures to spawn are ignored (the next trigger tries again).
 */
export function spawnDetachedSync(repo: string, tool: ToolKind, entry: string = binPath(), env: NodeJS.ProcessEnv = process.env): void {
  // An opt-out for sandboxes and tests: rounds then run only through `agentteams sync`.
  if (env.AGENTTEAMS_NO_BACKGROUND_SYNC === '1') return;
  try {
    const child = spawn(process.execPath, [entry, 'sync', '--repo', repo, '--tool', tool, '--quiet'], {
      detached: true, stdio: 'ignore', cwd: repo, env,
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
