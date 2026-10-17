/**
 * The real terminal behind the watch loop: alternate screen, hidden cursor and raw input while running, and
 * a restore that runs exactly once on every way out (q, Ctrl+C, SIGTERM, SIGHUP, an uncaught error, exit).
 */
import type { Screen } from './loop.js';

const ENTER = '\u001b[?1049h\u001b[?25l\u001b[2J';
const LEAVE = '\u001b[?2026l\u001b[0m\u001b[?25h\u001b[?1049l';
const FALLBACK_SIZE = { width: 80, height: 24 };

export interface TerminalStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export function processScreen(io: TerminalStreams = { stdin: process.stdin, stdout: process.stdout }): Screen {
  const { stdin, stdout } = io;
  let active = false;
  return {
    size: () => ({ width: stdout.columns || FALLBACK_SIZE.width, height: stdout.rows || FALLBACK_SIZE.height }),
    write: (s) => { stdout.write(s); },
    enter() {
      active = true;
      stdout.write(ENTER);
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.setEncoding('utf8');
      stdin.resume();
    },
    restore() {
      if (!active) return;
      active = false;
      try { if (stdin.isTTY) stdin.setRawMode(false); } catch { /* stdin already closed */ }
      stdin.pause();
      stdout.write(LEAVE);
    },
    onKey(cb) {
      const handler = (d: Buffer | string) => cb(String(d));
      stdin.on('data', handler);
      return () => { stdin.off('data', handler); };
    },
    onResize(cb) {
      stdout.on('resize', cb);
      return () => { stdout.off('resize', cb); };
    },
  };
}

/**
 * Process-level safety net while the dashboard runs: SIGINT/SIGTERM/SIGHUP stop it through `stop` (the loop
 * then restores the terminal); an uncaught error or process exit restores the terminal directly.
 * Returns a function that removes the handlers.
 */
export function installRestoreGuards(screen: Screen, stop: () => void): () => void {
  const onSignal = () => stop();
  const onExit = () => screen.restore();
  const onFatal = (err: unknown) => {
    screen.restore();
    process.stderr.write(`agentteams: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const s of signals) process.on(s, onSignal);
  process.on('exit', onExit);
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  return () => {
    for (const s of signals) process.off(s, onSignal);
    process.off('exit', onExit);
    process.off('uncaughtException', onFatal);
    process.off('unhandledRejection', onFatal);
  };
}
