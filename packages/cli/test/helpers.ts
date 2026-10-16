import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliDeps, Exec, ExecResult } from '../src/deps.js';

export interface FakeExecCall { cmd: string; args: string[]; cwd?: string }

/** exec fake: answers from a table keyed by "cmd arg0 arg1…" (exact) or "cmd" (any args); unknown → code 127. */
export function fakeExec(table: Record<string, Partial<ExecResult>>, calls: FakeExecCall[] = []): Exec {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    const hit = table[[cmd, ...args].join(' ')] ?? table[cmd];
    if (!hit) return { code: 127, stdout: '', stderr: `command not found: ${cmd}` };
    return { code: 0, stdout: '', stderr: '', ...hit };
  };
}

export interface TestCli { deps: CliDeps; root: string; out: string[]; err: string[]; raw: string[]; calls: FakeExecCall[]; cleanup: () => void }

export function makeTestCli(over: Partial<CliDeps> = {}, table: Record<string, Partial<ExecResult>> = {}): TestCli {
  const root = mkdtempSync(join(tmpdir(), 'agentteams-cli-'));
  const homedir = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(homedir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const raw: string[] = [];
  const calls: FakeExecCall[] = [];
  const deps: CliDeps = {
    env: {}, cwd: repo, homedir, username: 'Ronit K',
    exec: fakeExec({ 'git rev-parse --show-toplevel': { stdout: `${repo}\n` }, ...table }, calls),
    fetch: globalThis.fetch,
    out: (l) => out.push(l), write: (s) => raw.push(s), err: (l) => err.push(l),
    readStdin: async () => '',
    isTTY: false, prompt: async () => '',
    ...over,
  };
  return { deps, root, out, err, raw, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
