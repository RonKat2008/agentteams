import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskView, ToolKind } from '@agentteams/shared';
import { loadCredentials, type Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { cliArgv } from '../paths.js';
import { real } from '../repo.js';
import { afterRun } from '../run/afterRun.js';
import {
  agentCommand, binaryFor, commitsItself, isRunnable, onPath, taskPrompt, unsupportedToolMessage, type RunnableTool,
} from '../run/agentCommands.js';
import type { ProcessRunner } from '../run/runner.js';
import { clientFor, noCredentialsMessage, requireCredential, teamKey } from './shared.js';
import { ensureTaskWorktree, repoRootOf, type TaskWorktree } from './worktree.js';

export interface RunOpts {
  agent?: ToolKind;
  model?: string;
  detach?: boolean;
  /** Internal: this process is the background supervisor a --detach run started (tool output goes to the log only). */
  supervise?: boolean;
}
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

/** `<git-common-dir>/agentteams/runs`: one `<team>-<task>-<agent>.log` (and `.pid` while it runs) per run. */
async function runsDir(deps: CliDeps, root: string): Promise<string> {
  const dir = join(await gitCommonDir(deps, root), 'agentteams', 'runs');
  await mkdir(dir, { recursive: true });
  return dir;
}

/** A short, stable tag for the credential's team: task numbers and agent names are only unique within a team. */
const teamTag = (cred: Credential): string => createHash('sha256').update(teamKey(cred)).digest('hex').slice(0, 8);
const busyKey = (cred: Credential): string => `${teamTag(cred)}/${cred.agentName}`;
const runBase = (dir: string, cred: Credential, task: number): string => join(dir, `${teamTag(cred)}-${task}-${cred.agentName}`);

const pidIn = async (file: string): Promise<number> => Number.parseInt((await readFile(file, 'utf8').catch(() => '')).trim(), 10);

async function livePid(deps: CliDeps, pidFile: string): Promise<number | null> {
  const pid = await pidIn(pidFile);
  return Number.isInteger(pid) && pid > 0 && runnerOf(deps).isAlive(pid) ? pid : null;
}

/** Team-and-agent keys (busyKey) that have a run still alive, from the pid files. */
async function busyAgents(deps: CliDeps, dir: string): Promise<Set<string>> {
  const busy = new Set<string>();
  for (const name of await readdir(dir)) {
    const m = /^([0-9a-f]{8})-\d+-(.+)\.pid$/.exec(name);
    if (m && (await livePid(deps, join(dir, name)))) busy.add(`${m[1]}/${m[2]}`);
  }
  return busy;
}

interface Launch { cred: Credential & { tool: RunnableTool }; task: TaskView; wt: TaskWorktree; dir: string; model?: string }

/** --detach: starts `agentteams run <task> --supervise` in the background; it runs the tool and commits afterwards. */
async function launchSupervisor(deps: CliDeps, l: Launch): Promise<number> {
  const { cred, task } = l;
  const base = runBase(l.dir, cred, task.number);
  const log = `${base}.log`;
  const self = cliArgv();
  const args = [...self.args, 'run', String(task.number), '--agent', cred.tool, '--supervise', ...(l.model ? ['--model', l.model] : [])];
  await appendFile(log, `agentteams run: background run of task #${task.number} as ${cred.agentName} (${new Date().toISOString()})\n`);
  const res = await runnerOf(deps).start(self.command, args, { cwd: l.wt.root, logPath: log, detach: true });
  if (res.error) throw new Error(`could not start agentteams in the background: ${res.error}`);
  if (res.pid) await writeFile(`${base}.pid`, `${res.pid}\n`);
  deps.out(`Started ${binaryFor(cred.tool)} as ${cred.agentName} on task #${task.number} in the background (pid ${res.pid ?? 'unknown'}) in ${l.wt.path}`);
  deps.out(`Follow it with: tail -f ${log}`);
  if (res.pid) deps.out(`Stop it with: kill ${res.pid}`);
  return 0;
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * While the tool runs, Ctrl-C or `kill <pid>` (of a foreground run or a background supervisor) must not just end this
 * process: that would orphan the tool, still working unattended, and leave its pid file. The signal aborts `signal`
 * instead, and the runner passes it on to the tool.
 */
function stopSignals(): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const handlers = STOP_SIGNALS.map((sig) => [sig, () => { if (!ac.signal.aborted) ac.abort(sig); }] as const);
  for (const [sig, h] of handlers) process.on(sig, h);
  return { signal: ac.signal, dispose: () => { for (const [sig, h] of handlers) process.off(sig, h); } };
}

/** Runs the tool here and waits for it (a foreground run, or the supervisor), then commits and reports. */
async function launchHere(deps: CliDeps, l: Launch, echo: boolean): Promise<number> {
  const { cred, task, wt } = l;
  const base = runBase(l.dir, cred, task.number);
  const log = `${base}.log`;
  const prompt = taskPrompt({
    agent: cred.agentName, team: cred.teamName, task, worktree: wt.path, branch: wt.branch, commits: commitsItself(cred.tool),
  });
  const { bin, args } = agentCommand(cred.tool, { prompt, worktree: wt.path, model: l.model });
  const shown = args.map((a) => (a === prompt ? '<prompt>' : a)).join(' ');
  await appendFile(log, `agentteams run: ${bin} ${shown} (task #${task.number} as ${cred.agentName}, ${new Date().toISOString()})\n`);
  deps.out(`Starting ${bin} as ${cred.agentName} on task #${task.number} in ${wt.path}`);
  deps.out(`Log: ${log}`);
  await writeFile(`${base}.pid`, `${process.pid}\n`);
  const stop = stopSignals();
  try {
    const res = await runnerOf(deps).start(bin, args, { cwd: wt.path, logPath: log, detach: false, echo, signal: stop.signal });
    if (res.error) throw new Error(`could not start ${bin}: ${res.error}`);
    if (stop.signal.aborted) {
      deps.err(`agentteams: stopped ${bin} (${String(stop.signal.reason)}); nothing was committed and ${wt.path} is left as it is`);
      deps.out(`To start it again: agentteams run ${task.number} --agent ${cred.tool}`);
      return res.code ?? 1;
    }
    const code = res.code ?? 1;
    if (code !== 0) deps.err(`agentteams: ${bin} exited with code ${code}; log: ${log}`);
    else deps.out(`${bin} finished; log: ${log}`);
    await afterRun(deps, { cred, tool: cred.tool, client: clientFor(deps, cred), task, path: wt.path, branch: wt.branch, root: wt.root, log });
    return code;
  } finally {
    stop.dispose();
    if ((await pidIn(`${base}.pid`)) === process.pid) await rm(`${base}.pid`, { force: true });
  }
}

/** `agentteams run <task>`: start the assignee's tool on one task, in the foreground unless `detach`. */
export async function runCommand(deps: CliDeps, task: number, opts: RunOpts): Promise<number> {
  if (opts.agent && !isRunnable(opts.agent)) throw new Error(unsupportedToolMessage(opts.agent));
  const cred = await requireCredential(deps, opts.agent);
  const tool = cred.tool;
  if (!isRunnable(tool)) throw new Error(unsupportedToolMessage(tool));
  const view = await clientFor(deps, cred).getTask(task);
  if (view.status === 'done') throw new Error(`task #${task} is already done`);
  if (view.assignee !== cred.agentName) {
    throw new Error(`task #${task} is assigned to ${view.assignee ?? 'nobody'}, not ${cred.agentName}; `
      + "run it with the assignee's --agent <tool>, or assign it first");
  }
  const bin = binaryFor(tool);
  if (!(await onPath(bin, deps.env))) throw new Error(`${bin} is not installed (not found on PATH)`);
  const dir = await runsDir(deps, await repoRootOf(deps));
  const pid = await livePid(deps, `${runBase(dir, cred, task)}.pid`);
  if (pid && pid !== process.pid) throw new Error(`task #${task} is already running (pid ${pid}) for ${cred.agentName}`);
  const wt = await ensureTaskWorktree(deps, cred, task);
  const l: Launch = { cred: { ...cred, tool }, task: view, wt, dir, model: opts.model };
  if (opts.detach && !opts.supervise) return launchSupervisor(deps, l);
  return launchHere(deps, l, !opts.supervise);
}

async function repoCredentials(deps: CliDeps, root: string): Promise<Credential[]> {
  const here = await real(root);
  const creds = (await loadCredentials(deps)).filter((c) => c.repoPath === here);
  if (creds.length === 0) throw new Error(noCredentialsMessage(root));
  return creds;
}

/** This repo's credentials grouped by team: a task is only ever run by a credential of its own team. */
function byTeam(creds: Credential[]): Credential[][] {
  const teams = new Map<string, Credential[]>();
  for (const c of creds) teams.set(teamKey(c), [...(teams.get(teamKey(c)) ?? []), c]);
  return [...teams.values()];
}

async function skipReason(deps: CliDeps, task: TaskView, cred: Credential | undefined, dir: string, busy: Set<string>): Promise<string | null> {
  if (!cred) return 'not an agent on this computer';
  if (!isRunnable(cred.tool)) return `agentteams run cannot start ${cred.tool}`;
  const log = `${runBase(dir, cred, task.number)}.log`;
  if (await exists(log)) return `already started once (log: ${log}); agentteams run ${task.number} --agent ${cred.tool} starts it again`;
  if (busy.has(busyKey(cred))) return `${cred.agentName} already has a run going`;
  const bin = binaryFor(cred.tool);
  return (await onPath(bin, deps.env)) ? null : `${bin} is not installed`;
}

/** Prints `line` unless this watch already printed it. */
const once = (print: (l: string) => void, seen: Set<string> | undefined, line: string): void => {
  if (seen?.has(line)) return;
  seen?.add(line);
  print(line);
};

interface Pass { started: number; failed: number }

/** One pass over the board: starts a background run for each assigned, unfinished task this computer can run. */
async function runAllPass(deps: CliDeps, model: string | undefined, seen?: Set<string>): Promise<Pass> {
  const root = await repoRootOf(deps);
  const teams = byTeam(await repoCredentials(deps, root));
  const dir = await runsDir(deps, root);
  const busy = await busyAgents(deps, dir);
  const pass: Pass = { started: 0, failed: 0 };
  for (const members of teams) {
    const team = teams.length > 1 ? `${members[0]!.teamName} ` : '';
    for (const task of await clientFor(deps, members[0]!).listTasks()) {
      if (!task.assignee || task.status === 'done') continue;
      const cred = members.find((c) => c.agentName === task.assignee);
      const reason = await skipReason(deps, task, cred, dir, busy);
      if (reason || !cred || !isRunnable(cred.tool)) { once(deps.out, seen, `skipped ${team}#${task.number} (${task.assignee}): ${reason}`); continue; }
      try {
        const wt = await ensureTaskWorktree({ ...deps, cwd: root }, cred, task.number);
        await launchSupervisor(deps, { cred: { ...cred, tool: cred.tool }, task, wt, dir, model });
        busy.add(busyKey(cred));
        pass.started += 1;
      } catch (e) {
        deps.err(`agentteams: ${team}task #${task.number}: ${message(e)}`);
        pass.failed += 1;
      }
    }
  }
  return pass;
}

export async function runAllCommand(deps: CliDeps, opts: { model?: string }): Promise<number> {
  const { started: n, failed } = await runAllPass(deps, opts.model);
  deps.out(n === 0 ? 'Nothing to start.' : `Started ${n} run${n === 1 ? '' : 's'} in the background.`);
  return failed > 0 ? 1 : 0;
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
