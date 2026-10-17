import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveCredential } from '../src/credentials.js';
import { realExec, type Exec } from '../src/deps.js';
import { main } from '../src/main.js';
import { runWatchCommand } from '../src/commands/run.js';
import { agentCommand, RUNNABLE_TOOLS } from '../src/run/agentCommands.js';
import type { ProcessRunner, RunOpts } from '../src/run/runner.js';
import { openTeamStore } from '../src/local/store.js';
import { makeTestCli, type TestCli } from './helpers.js';
import { gitDeps, makeRepo, seedTeam, type Seeded, type TempRepo } from './localHelpers.js';

interface Start extends RunOpts { cmd: string; args: string[] }

let r: TempRepo;
let s: Seeded;
let cli: TestCli;
let starts: Start[];
let alive: Set<number>;
let binDir: string;

/** Real git; every other tool (claude mcp add, ...) succeeds without running. */
const gitOnly: Exec = async (cmd, args, opts) => (cmd === 'git' ? realExec(cmd, args, opts) : { code: 0, stdout: '', stderr: '' });

const fakeRunner = (code = 0): ProcessRunner => ({
  async start(cmd, args, opts) {
    starts.push({ cmd, args, ...opts });
    if (!opts.detach) return { code };
    const pid = 4242 + starts.length;
    alive.add(pid);
    return { code: null, pid };
  },
  isAlive: (pid) => alive.has(pid),
});

const installBins = (...bins: string[]) => {
  for (const b of bins) { writeFileSync(join(binDir, b), '#!/bin/sh\nexit 0\n'); chmodSync(join(binDir, b), 0o755); }
};

async function addTask(title: string, assignee?: string): Promise<number> {
  const { ctx, core } = await openTeamStore(gitDeps, r.repo);
  const actor = await core.authenticate(ctx, s.alice.apiKey);
  const { createTask } = await import('../../hub/src/services/tasks.js');
  return (await createTask(ctx, actor, { title, description: '', ...(assignee ? { assignee } : {}) })).number;
}

const run = (...args: string[]) => main(['node', 'agentteams', ...args], cli.deps);
const wtOf = (agent: string, task: number) => join(r.repo, '.agentteams', 'worktrees', agent, String(task));
const runsDir = () => join(r.repo, '.git', 'agentteams', 'runs');

beforeEach(async () => {
  r = makeRepo();
  s = await seedTeam(r.repo);
  binDir = join(r.root, 'bin');
  mkdirSync(binDir);
  starts = [];
  alive = new Set();
  cli = makeTestCli({ exec: gitOnly, cwd: r.repo, homedir: join(r.root, 'home'), env: { PATH: binDir }, runner: fakeRunner() });
  await saveCredential(cli.deps, s.alice);
  await saveCredential(cli.deps, s.bob);
});
afterEach(() => { cli.cleanup(); r.cleanup(); });

describe('agent commands', () => {
  const ctx = { prompt: 'PROMPT', worktree: '/w', gitDir: '/r/.git' };

  it('supports exactly claude, codex, cursor and gemini', () => {
    expect([...RUNNABLE_TOOLS].sort()).toEqual(['claude', 'codex', 'cursor', 'gemini']);
  });

  it('codex: codex exec in a workspace-write sandbox that may also write the repo .git', () => {
    expect(agentCommand('codex', { ...ctx, model: 'gpt-5' })).toEqual({
      bin: 'codex',
      args: ['exec', '--sandbox', 'workspace-write', '--add-dir', '/r/.git', '-C', '/w', '--model', 'gpt-5', 'PROMPT'],
    });
  });

  it('cursor: cursor-agent -p with the workspace trusted and the MCP server approved', () => {
    expect(agentCommand('cursor', ctx)).toEqual({
      bin: 'cursor-agent',
      args: ['-p', '--output-format', 'text', '--trust', '--approve-mcps', '--force', '--workspace', '/w', '--add-dir', '/r/.git', 'PROMPT'],
    });
  });

  it('claude: claude -p accepting edits, with the agentteams MCP tools and git allowed', () => {
    expect(agentCommand('claude', { ...ctx, model: 'opus' }).args).toEqual(
      ['-p', 'PROMPT', '--model', 'opus', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__agentteams', 'Bash(git *)']);
  });

  it('gemini: gemini -p in yolo mode (the only mode that can call MCP tools headless)', () => {
    expect(agentCommand('gemini', { ...ctx, model: 'gemini-2.5-pro' })).toEqual({
      bin: 'gemini', args: ['-p', 'PROMPT', '--model', 'gemini-2.5-pro', '--yolo'],
    });
  });
});

describe('agentteams run <task>', () => {
  it('claims the task, makes its worktree and runs the assignee tool there in the foreground', async () => {
    installBins('codex');
    const n = await addTask('Login page', s.bob.agentName);
    expect(await run('run', String(n), '--agent', 'codex')).toBe(0);
    expect(starts).toHaveLength(1);
    const [st] = starts;
    const wt = wtOf(s.bob.agentName, n);
    expect(st).toMatchObject({ cmd: 'codex', cwd: wt, detach: false, logPath: join(runsDir(), `${n}-${s.bob.agentName}.log`) });
    expect(st!.args.slice(0, 7)).toEqual(['exec', '--sandbox', 'workspace-write', '--add-dir', join(r.repo, '.git'), '-C', wt]);
    const prompt = st!.args.at(-1)!;
    expect(prompt).toContain(`task #${n}`);
    expect(prompt).toContain('claim_task');
    expect(prompt).toContain('complete_task');
    expect(prompt).toContain(`agentteams done ${n} -m`);
    expect(prompt).toContain(`at/${s.bob.agentName}/${n}`);
    expect(existsSync(join(wt, 'a.txt'))).toBe(true);
    expect(readFileSync(st!.logPath, 'utf8')).toContain('agentteams run: codex exec');
    expect(cli.out.join('\n')).toContain(`Log: ${st!.logPath}`);
    const { ctx, core } = await openTeamStore(gitDeps, r.repo);
    expect((await core.getTaskView(ctx, await core.authenticate(ctx, s.bob.apiKey), n)).status).toBe('in_progress');
  });

  it("returns the tool's exit code", async () => {
    installBins('codex');
    cli.deps.runner = fakeRunner(3);
    const n = await addTask('x', s.bob.agentName);
    expect(await run('run', String(n), '--agent', 'codex')).toBe(3);
    expect(cli.err.join('\n')).toContain('codex exited with code 3');
  });

  it('passes --model through', async () => {
    installBins('codex');
    const n = await addTask('x', s.bob.agentName);
    expect(await run('run', String(n), '--agent', 'codex', '--model', 'gpt-5-codex')).toBe(0);
    expect(starts[0]!.args).toContain('gpt-5-codex');
  });

  it('--detach starts it in the background and records the pid', async () => {
    installBins('codex');
    const n = await addTask('x', s.bob.agentName);
    expect(await run('run', String(n), '--agent', 'codex', '--detach')).toBe(0);
    expect(starts[0]!.detach).toBe(true);
    expect(readFileSync(join(runsDir(), `${n}-${s.bob.agentName}.pid`), 'utf8').trim()).toBe('4243');
    expect(cli.out.join('\n')).toMatch(/pid 4243/);
  });

  it('refuses a second run of the same task while the first is alive', async () => {
    installBins('codex');
    const n = await addTask('x', s.bob.agentName);
    expect(await run('run', String(n), '--agent', 'codex', '--detach')).toBe(0);
    expect(await run('run', String(n), '--agent', 'codex')).toBe(1);
    expect(cli.err.join('\n')).toContain('already running (pid 4243)');
    expect(starts).toHaveLength(1);
  });

  it('runs as the assignee only: another agent\'s task is refused before anything starts', async () => {
    installBins('codex');
    const n = await addTask('x', s.alice.agentName);
    expect(await run('run', String(n), '--agent', 'codex')).toBe(1);
    expect(cli.err.join('\n')).toContain(`task #${n} is assigned to ${s.alice.agentName}, not ${s.bob.agentName}`);
    expect(starts).toEqual([]);
  });

  it('names the supported tools for a tool it cannot start', async () => {
    const n = await addTask('x', s.bob.agentName);
    expect(await run('run', String(n), '--agent', 'copilot')).toBe(1);
    expect(cli.err.join('\n')).toMatch(/cannot start copilot.*claude, codex, cursor, gemini/);
    expect(starts).toEqual([]);
  });

  it('says when the tool is not installed, and creates no worktree', async () => {
    const n = await addTask('x', s.bob.agentName);
    expect(await run('run', String(n), '--agent', 'codex')).toBe(1);
    expect(cli.err.join('\n')).toContain('codex is not installed (not found on PATH)');
    expect(existsSync(wtOf(s.bob.agentName, n))).toBe(false);
  });

  it('refuses a finished task', async () => {
    installBins('codex');
    const n = await addTask('x', s.bob.agentName);
    const { ctx, core } = await openTeamStore(gitDeps, r.repo);
    const bob = await core.authenticate(ctx, s.bob.apiKey);
    await core.claimTask(ctx, bob, { task: n });
    await core.completeTask(ctx, bob, { task: n, summary: 'done', branch: 'b' } as never);
    expect(await run('run', String(n), '--agent', 'codex')).toBe(1);
    expect(cli.err.join('\n')).toContain(`task #${n} is already done`);
  });

  it('needs a task number or --all', async () => {
    expect(await run('run')).toBe(1);
    expect(cli.err.join('\n')).toMatch(/task number.*--all/);
  });
});

describe('agentteams run --all', () => {
  it('starts every assigned, unfinished task whose agent is on this computer and runnable, in the background', async () => {
    installBins('codex', 'claude');
    const { ctx, core } = await openTeamStore(gitDeps, r.repo);
    const carol = await core.joinTeam(ctx, { inviteCode: s.inviteCode, member: 'carol', tool: 'cursor' });
    const t1 = await addTask('a', s.bob.agentName);
    const t2 = await addTask('b', s.alice.agentName);
    await addTask('unassigned');
    const t4 = await addTask('c', carol.agentName);
    const t5 = await addTask('d', s.bob.agentName);
    expect(await run('run', '--all')).toBe(0);
    expect(starts.map((x) => [x.cmd, x.cwd, x.detach])).toEqual([
      ['codex', wtOf(s.bob.agentName, t1), true],
      ['claude', wtOf(s.alice.agentName, t2), true],
    ]);
    const out = cli.out.join('\n');
    expect(out).toContain(`#${t4} (${carol.agentName}): not an agent on this computer`);
    expect(out).toContain(`#${t5} (${s.bob.agentName}): ${s.bob.agentName} already has a run going`);
    expect(out).toContain('Started 2 runs');
  });

  it('skips tasks that already had a run, and agents whose tool is missing', async () => {
    installBins('codex');
    const t1 = await addTask('a', s.bob.agentName);
    const t2 = await addTask('b', s.alice.agentName);
    expect(await run('run', '--all')).toBe(0);
    alive.clear();
    cli.out.length = 0;
    expect(await run('run', '--all')).toBe(0);
    expect(starts).toHaveLength(1);
    expect(cli.out.join('\n')).toContain(`#${t1} (${s.bob.agentName}): already started once (log:`);
    expect(cli.out.join('\n')).toContain(`#${t2} (${s.alice.agentName}): claude is not installed`);
  });

  it('--all with a task number is refused', async () => {
    expect(await run('run', '1', '--all')).toBe(1);
    expect(cli.err.join('\n')).toMatch(/either a task number or --all/);
  });
});

describe('agentteams run --watch', () => {
  it('polls the board and starts runs for new assignments until stopped, reporting each skip once', async () => {
    installBins('codex', 'claude');
    await addTask('a', s.bob.agentName);
    await addTask('nobody');
    const ac = new AbortController();
    let polls = 0;
    let later = 0;
    const sleep = async () => {
      polls += 1;
      if (polls === 1) later = await addTask('b', s.alice.agentName);
      if (polls === 3) ac.abort();
    };
    await runWatchCommand(cli.deps, { intervalSec: 1 }, { signal: ac.signal, sleep });
    expect(starts.map((x) => x.cwd)).toEqual([wtOf(s.bob.agentName, 1), wtOf(s.alice.agentName, later)]);
    expect(cli.out.filter((l) => l.includes(`#1 (${s.bob.agentName}): already started once`))).toHaveLength(1);
  });
});
