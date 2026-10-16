import { execFile } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { colorEnabled } from './color.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Raw stdout bytes; set only when the call asked for `binary: true`. */
  stdoutBuf?: Buffer;
}
export interface ExecOpts {
  cwd?: string;
  input?: string | Buffer;
  /** Extra environment variables, merged over process.env. */
  env?: Record<string, string>;
  /** Also return stdout as an unmodified Buffer in `stdoutBuf`. */
  binary?: boolean;
}
export type Exec = (cmd: string, args: string[], opts?: ExecOpts) => Promise<ExecResult>;

export interface CliDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  exec: Exec;
  fetch: typeof fetch;
  out: (line: string) => void;
  write: (raw: string) => void;
  err: (line: string) => void;
  readStdin: () => Promise<string>;
  homedir: string;
  username: string;
  isTTY: boolean;
  color: boolean;
  prompt: (question: string) => Promise<string>;
}

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const env = opts.env ? { ...process.env, ...opts.env } : undefined;
    const encoding = opts.binary ? 'buffer' : 'utf8';
    const child = execFile(cmd, args, { cwd: opts.cwd, env, encoding, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ code: 127, stdout: '', stderr: `command not found: ${cmd}` });
        return;
      }
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({
        code,
        stdout: String(stdout),
        stderr: String(stderr),
        ...(opts.binary ? { stdoutBuf: Buffer.from(stdout) } : {}),
      });
    });
    // Always close stdin (so children never wait on input) and swallow EPIPE-style errors.
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input);
  });

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readlinePrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export function realDeps(): CliDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    exec: realExec,
    fetch: globalThis.fetch,
    out: (line) => process.stdout.write(`${line}\n`),
    write: (raw) => process.stdout.write(raw),
    err: (line) => process.stderr.write(`${line}\n`),
    readStdin: readAllStdin,
    homedir: homedir(),
    username: process.env.USER || userInfo().username,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    color: colorEnabled(process.env, Boolean(process.stdout.isTTY)),
    prompt: readlinePrompt,
  };
}
