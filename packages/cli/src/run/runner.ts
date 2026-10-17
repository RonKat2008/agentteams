import { spawn } from 'node:child_process';
import { closeSync, createWriteStream, openSync } from 'node:fs';

export interface RunOpts {
  cwd: string;
  /** Appended to; the child's stdout and stderr both go here. */
  logPath: string;
  /** Start in the background (own process group, not waited for) instead of streaming to this terminal. */
  detach: boolean;
  /** Foreground only: false writes the output to the log alone (a background supervisor's stdout already is the log). */
  echo?: boolean;
}
/** `code` is null for a detached child (not waited for); `error` is set when it could not be started. */
export interface RunResult { code: number | null; pid?: number; error?: string }

/** Starts agent tools (`agentteams run`). Injectable so tests never launch a real one. */
export interface ProcessRunner {
  start(cmd: string, args: string[], opts: RunOpts): Promise<RunResult>;
  isAlive(pid: number): boolean;
}

const COMMAND_NOT_FOUND = 127;

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

/** Streams the child's output to the log (and, unless `echo` is false, this terminal); resolves with its exit code. */
function startForeground(cmd: string, args: string[], opts: RunOpts): Promise<RunResult> {
  const log = createWriteStream(opts.logPath, { flags: 'a' });
  const echo = opts.echo !== false;
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d: Buffer) => { if (echo) process.stdout.write(d); log.write(d); });
  child.stderr.on('data', (d: Buffer) => { if (echo) process.stderr.write(d); log.write(d); });
  return new Promise((resolve) => {
    child.once('error', (e) => log.end(() => resolve({ code: COMMAND_NOT_FOUND, error: e.message })));
    child.once('close', (code) => log.end(() => resolve({ code: code ?? 1, ...(child.pid ? { pid: child.pid } : {}) })));
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
