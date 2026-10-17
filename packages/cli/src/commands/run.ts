import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskView, ToolKind } from '@agentteams/shared';
import { loadCredentials, type Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { real } from '../repo.js';
import { agentCommand, binaryFor, isRunnable, onPath, taskPrompt, unsupportedToolMessage } from '../run/agentCommands.js';
import type { ProcessRunner } from '../run/runner.js';
import { clientFor, noCredentialsMessage, requireCredential } from './shared.js';
import { ensureTaskWorktree, repoRootOf, type TaskWorktree } from './worktree.js';

export interface RunOpts { agent?: ToolKind; model?: string; detach?: boolean }
export interface WatchOpts { model?: string; intervalSec: number }
export interface RunEntryOpts extends RunOpts { all?: boolean; watch?: boolean; interval: number }
type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

const DEFAULT_SLEEP: Sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function runnerOf(deps: CliDeps): ProcessRunner {
  if (!deps.runner) throw new Error('internal error: no process runner');
  return deps.runner;
}

async function gitCommonDir(deps: CliDeps, cwd: string): Promise<string> {
  const r = await deps.exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (r.code !== 0 || !r.stdout.trim()) throw new Error('not inside a git repository');
  return r.stdout.trim();
}

/** `<git-common-dir>/agentteams/runs`: one `<task>-<agent>.log` (and `.pid` for a background run) per run. */
async function runsDir(deps: CliDeps, root: string): Promise<string> {
  const dir = join(await gitCommonDir(deps, root), 'agentteams', 'runs');
  await mkdir(dir, { recursive: true });
  return dir;
}

const runBase = (dir: string, task: number, agent: string): string => join(dir, `${task}-${agent}`);

async function livePid(deps: CliDeps, pidFile: string): Promise<number | null> {
  const pid = Number.parseInt((await readFile(pidFile, 'utf8').catch(() => '')).trim(), 10);
  return Number.isInteger(pid) && pid > 0 && runnerOf(deps).isAlive(pid) ? pid : null;
}

/** Agents that have a background run still alive (from the pid files). */
async function busyAgents(deps: CliDeps, dir: string): Promise<Set<string>> {
  const busy = new Set<string>();
  for (const name of await readdir(dir)) {
    const m = /^\d+-(.+)\.pid$/.exec(name);
    if (m && (await livePid(deps, join(dir, name)))) busy.add(m[1]!);
  }
  return busy;
}

interface Launch { cred: Credential; task: TaskView; wt: TaskWorktree; dir: string; model?: string; detach: boolean }

/** Starts the agent's tool in the task worktree; returns its exit code (0 once a background run has started). */
async function launch(deps: CliDeps, l: Launch): Promise<number> {
  const { cred, task, wt } = l;
  const base = runBase(l.dir, task.number, cred.agentName);
  const log = `${base}.log`;
  const prompt = taskPrompt({ agent: cred.agentName, team: cred.teamName, task, worktree: wt.path, branch: wt.branch });
  const { bin, args } = agentCommand(cred.tool, { prompt, worktree: wt.path, gitDir: await gitCommonDir(deps, wt.root), model: l.model });
  const shown = args.map((a) => (a === prompt ? '<prompt>' : a)).join(' ');
  await appendFile(log, `agentteams run: ${bin} ${shown} (task #${task.number} as ${cred.agentName}, ${new Date().toISOString()})\n`);
  deps.out(`Starting ${bin} as ${cred.agentName} on task #${task.number} in ${wt.path}`);
  deps.out(`Log: ${log}`);
  const res = await runnerOf(deps).start(bin, args, { cwd: wt.path, logPath: log, detach: l.detach });
  if (res.error) throw new Error(`could not start ${bin}: ${res.error}`);
  if (l.detach) {
    if (res.pid) await writeFile(`${base}.pid`, `${res.pid}\n`);
    deps.out(`Started in the background (pid ${res.pid ?? 'unknown'}). Follow it with: tail -f ${log}`);
    return 0;
  }
  const code = res.code ?? 1;
  if (code !== 0) deps.err(`agentteams: ${bin} exited with code ${code}; log: ${log}`);
  else deps.out(`${bin} finished; log: ${log}`);
  return code;
}

/** `agentteams run <task>`: start the assignee's tool on one task, in the foreground unless `detach`. */
export async function runCommand(deps: CliDeps, task: number, opts: RunOpts): Promise<number> {
  if (opts.agent && !isRunnable(opts.agent)) throw new Error(unsupportedToolMessage(opts.agent));
  const cred = await requireCredential(deps, opts.agent);
  if (!isRunnable(cred.tool)) throw new Error(unsupportedToolMessage(cred.tool));
  const view = await clientFor(deps, cred).getTask(task);
  if (view.status === 'done') throw new Error(`task #${task} is already done`);
  if (view.assignee !== cred.agentName) {
    throw new Error(`task #${task} is assigned to ${view.assignee ?? 'nobody'}, not ${cred.agentName}; `
      + "run it with the assignee's --agent <tool>, or assign it first");
  }
  const bin = binaryFor(cred.tool);
  if (!(await onPath(bin, deps.env))) throw new Error(`${bin} is not installed (not found on PATH)`);
  const dir = await runsDir(deps, await repoRootOf(deps));
  const pid = await livePid(deps, `${runBase(dir, task, cred.agentName)}.pid`);
  if (pid) throw new Error(`task #${task} is already running (pid ${pid}) for ${cred.agentName}`);
  const wt = await ensureTaskWorktree(deps, cred, task);
  return launch(deps, { cred, task: view, wt, dir, model: opts.model, detach: Boolean(opts.detach) });
}

async function repoCredentials(deps: CliDeps, root: string): Promise<Credential[]> {
  const here = await real(root);
  const creds = (await loadCredentials(deps)).filter((c) => c.repoPath === here);
  if (creds.length === 0) throw new Error(noCredentialsMessage(root));
  return creds;
}

async function skipReason(deps: CliDeps, task: TaskView, cred: Credential | undefined, dir: string, busy: Set<string>): Promise<string | null> {
  if (!cred) return 'not an agent on this computer';
  if (!isRunnable(cred.tool)) return `agentteams run cannot start ${cred.tool}`;
  const log = `${runBase(dir, task.number, cred.agentName)}.log`;
  if (await exists(log)) return `already started once (log: ${log}); agentteams run ${task.number} --agent ${cred.tool} starts it again`;
  if (busy.has(cred.agentName)) return `${cred.agentName} already has a run going`;
  const bin = binaryFor(cred.tool);
  return (await onPath(bin, deps.env)) ? null : `${bin} is not installed`;
}

/** Prints `line` unless this watch already printed it. */
const once = (print: (l: string) => void, seen: Set<string> | undefined, line: string): void => {
  if (seen?.has(line)) return;
  seen?.add(line);
  print(line);
};

/** One pass over the board: starts a background run for each assigned, unfinished task this computer can run. */
async function runAllPass(deps: CliDeps, model: string | undefined, seen?: Set<string>): Promise<number> {
  const root = await repoRootOf(deps);
  const creds = await repoCredentials(deps, root);
  const dir = await runsDir(deps, root);
  const busy = await busyAgents(deps, dir);
  let started = 0;
  for (const task of await clientFor(deps, creds[0]!).listTasks()) {
    if (!task.assignee || task.status === 'done') continue;
    const cred = creds.find((c) => c.agentName === task.assignee);
    const reason = await skipReason(deps, task, cred, dir, busy);
    if (reason || !cred) { once(deps.out, seen, `skipped #${task.number} (${task.assignee}): ${reason}`); continue; }
    try {
      const wt = await ensureTaskWorktree({ ...deps, cwd: root }, cred, task.number);
      await launch(deps, { cred, task, wt, dir, model, detach: true });
      busy.add(cred.agentName);
      started += 1;
    } catch (e) {
      deps.err(`agentteams: task #${task.number}: ${message(e)}`);
    }
  }
  return started;
}

export async function runAllCommand(deps: CliDeps, opts: { model?: string }): Promise<number> {
  const n = await runAllPass(deps, opts.model);
  deps.out(n === 0 ? 'Nothing to start.' : `Started ${n} run${n === 1 ? '' : 's'} in the background.`);
  return 0;
}

/** `--watch`: poll the board and start runs for new assignments until `signal` aborts. Each skip is reported once. */
export async function runWatchCommand(
  deps: CliDeps, opts: WatchOpts, ctl: { signal: AbortSignal; sleep?: Sleep },
): Promise<number> {
  const sleep = ctl.sleep ?? DEFAULT_SLEEP;
  const seen = new Set<string>();
  deps.out(`Watching the task board every ${opts.intervalSec}s; Ctrl-C stops watching (started runs keep going).`);
  while (!ctl.signal.aborted) {
    try {
      await runAllPass(deps, opts.model, seen);
    } catch (e) {
      once(deps.err, seen, `agentteams: warning: ${message(e)}`);
    }
    if (ctl.signal.aborted) break;
    await sleep(opts.intervalSec * 1000, ctl.signal);
  }
  return 0;
}

export async function runEntry(deps: CliDeps, task: number | undefined, o: RunEntryOpts): Promise<number> {
  const many = Boolean(o.all || o.watch);
  if (task !== undefined && many) throw new Error('pass either a task number or --all/--watch, not both');
  if (task === undefined && !many) throw new Error('pass a task number (agentteams run <task>) or --all');
  if (task !== undefined) return runCommand(deps, task, o);
  if (o.agent) throw new Error("--all and --watch run each task as its assignee; drop --agent");
  if (!o.watch) return runAllCommand(deps, o);
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await runWatchCommand(deps, { model: o.model, intervalSec: o.interval }, { signal: ac.signal });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
