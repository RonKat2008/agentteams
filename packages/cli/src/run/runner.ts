import { spawn } from 'node:child_process';
import { closeSync, createWriteStream, openSync } from 'node:fs';
import { constants } from 'node:os';

export interface RunOpts {
  cwd: string;
  /** Appended to; the child's stdout and stderr both go here. */
  logPath: string;
  /** Start in the background (own process group, not waited for) instead of streaming to this terminal. */
  detach: boolean;
  /** Foreground only: false writes the output to the log alone (a background supervisor's stdout already is the log). */
  echo?: boolean;
  /** Foreground only: aborting sends the tool and everything it started the abort reason's signal (default SIGTERM). */
  signal?: AbortSignal;
}
/** `code` is null for a detached child (not waited for); `error` is set when it could not be started. */
export interface RunResult { code: number | null; pid?: number; error?: string }

/** Starts agent tools (`agentteams run`). Injectable so tests never launch a real one. */
export interface ProcessRunner {
  start(cmd: string, args: string[], opts: RunOpts): Promise<RunResult>;
  isAlive(pid: number): boolean;
}

const COMMAND_NOT_FOUND = 127;
/** A tool still running this long after it was signalled to stop is killed. */
const KILL_AFTER_MS = 10_000;

function startDetached(cmd: string, args: string[], opts: RunOpts): Promise<RunResult> {
  const fd = openSync(opts.logPath, 'a');
  try {
    const child = spawn(cmd, args, { cwd: opts.cwd, detached: true, stdio: ['ignore', fd, fd] });
    return new Promise((resolve) => {
      child.once('error', (e) => resolve({ code: COMMAND_NOT_FOUND, error: e.message }));
      child.once('spawn', () => { child.unref(); resolve({ code: null, ...(child.pid ? { pid: child.pid } : {}) }); });
    });
  } finally {
    closeSync(fd); // the child holds its own copy
  }
}

/** Signals the child's whole process group (it leads one), so tools it started stop too; then the child alone. */
function signalTree(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* already gone */ } }
}

const signalOf = (reason: unknown): NodeJS.Signals =>
  (typeof reason === 'string' && reason in constants.signals ? reason as NodeJS.Signals : 'SIGTERM');

/**
 * Streams the child's output to the log (and, unless `echo` is false, this terminal); resolves with its exit code
 * (128 + the signal number when a signal ended it). The child leads its own process group so that `signal` can stop
 * it with everything it started; nothing else signals that group, so this process forwards Ctrl-C through `signal`.
 */
function startForeground(cmd: string, args: string[], opts: RunOpts): Promise<RunResult> {
  const log = createWriteStream(opts.logPath, { flags: 'a' });
  const echo = opts.echo !== false;
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', (d: Buffer) => { if (echo) process.stdout.write(d); log.write(d); });
  child.stderr.on('data', (d: Buffer) => { if (echo) process.stderr.write(d); log.write(d); });
  let killer: NodeJS.Timeout | undefined;
  const stop = () => {
    signalTree(child.pid, signalOf(opts.signal?.reason));
    killer = setTimeout(() => signalTree(child.pid, 'SIGKILL'), KILL_AFTER_MS);
    killer.unref();
  };
  if (opts.signal?.aborted) stop();
  else opts.signal?.addEventListener('abort', stop, { once: true });
  return new Promise((resolve) => {
    const done = (res: RunResult) => {
      clearTimeout(killer);
      opts.signal?.removeEventListener('abort', stop);
      log.end(() => resolve(res));
    };
    child.once('error', (e) => done({ code: COMMAND_NOT_FOUND, error: e.message }));
    child.once('close', (code, sig) => {
      const exit = code ?? (sig ? 128 + (constants.signals[sig] ?? 0) : 1);
      done({ code: exit, ...(child.pid ? { pid: child.pid } : {}) });
    });
  });
}

export const realRunner: ProcessRunner = {
  start: (cmd, args, opts) => (opts.detach ? startDetached(cmd, args, opts) : startForeground(cmd, args, opts)),
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
};
