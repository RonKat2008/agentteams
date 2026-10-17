import type { TaskView, ToolKind } from '@agentteams/shared';
import { loadCredentials, type Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { currentBranch } from '../git.js';
import { detectTestCommand } from '../merge/detectTest.js';
import {
  changedFiles, createIntegrationWorktree, gitFailure, hasRef, INTEGRATION_BRANCH, mergeRef, pickRemote,
  removeIntegrationWorktree, taskRef,
} from '../merge/integrate.js';
import type { TeamClient } from '../teamClient.js';
import { assertSafeBranch, clientFor, readableTeams, teamKey } from './shared.js';
import { repoRootOf } from './worktree.js';

export interface MergeOpts {
  agent?: ToolKind;
  into?: string;
  /** A command string; false for --no-test; unset auto-detects. */
  test?: string | false;
  notify?: boolean;
  stopOnConflict?: boolean;
  dryRun?: boolean;
  push?: boolean;
}

/** Lines of test output shown. */
const TAIL_LINES = 40;

interface Merged { task: TaskView; files: string[] }
interface Run { deps: CliDeps; client: TeamClient; cred: Credential; root: string; base: string; wt: string; opts: MergeOpts }

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const label = (t: TaskView): string => `#${t.number} ${t.title} (${t.branch})`;

/** The repo's credential for the team's orchestrator (with --agent: that credential, which must be it). */
async function orchestrator(deps: CliDeps, agent?: ToolKind): Promise<{ cred: Credential; client: TeamClient }> {
  let name: string | null = null;
  let who = "none of this repo's agents is";
  for (const { cred } of await readableTeams(deps, agent)) {
    name = (await clientFor(deps, cred).status()).team.orchestrator;
    const candidates = agent ? [cred]
      : (await loadCredentials(deps)).filter((c) => c.repoPath === cred.repoPath && teamKey(c) === teamKey(cred));
    const mine = candidates.find((c) => c.agentName === name);
    if (mine) return { cred: mine, client: clientFor(deps, mine) };
    if (agent) who = `${cred.agentName} is not`;
  }
  throw new Error(`only the orchestrator${name ? ` (${name})` : ''} can merge tasks; ${who}`);
}

/** --into, else the branch checked out in the main checkout; it must have commits. */
async function pickBase(deps: CliDeps, root: string, into?: string): Promise<string> {
  if (into) {
    await assertSafeBranch(deps, root, into);
    if (!(await hasRef(deps, root, `refs/heads/${into}`))) throw new Error(`branch ${into} does not exist`);
    return into;
  }
  const base = await currentBranch(deps, root);
  if (base === 'HEAD') throw new Error(`${root} is not on a branch; pass --into <branch>`);
  if (!(await hasRef(deps, root, `refs/heads/${base}`))) throw new Error(`${base} has no commits yet, so there is nothing to merge into`);
  return base;
}

async function fetchRemote(deps: CliDeps, root: string, cred: Credential): Promise<string | null> {
  const remote = await pickRemote(deps, root, cred.git?.remote);
  if (!remote) return null;
  const r = await deps.exec('git', ['fetch', '--quiet', remote], { cwd: root });
  if (r.code !== 0) deps.err(`agentteams: warning: git fetch ${remote} failed; using local branches (${r.stderr.trim() || `exit ${r.code}`})`);
  return remote;
}

async function notifyConflict(run: Run, task: TaskView, partners: string, files: string[]): Promise<string> {
  const { client, cred, base, opts } = run;
  if (opts.notify === false || !task.assignee || task.assignee === cred.agentName) return '';
  const body = `Task #${task.number} (${task.title}) conflicts with ${partners} in ${files.join(', ') || 'some files'} when merged into ${base}. `
    + `Rebase ${task.branch} onto ${base} (git rebase ${base}), resolve the conflicts, rerun the tests and commit; `
    + 'push the branch if your team shares branches through a remote, then tell the orchestrator it is ready.';
  try {
    await client.sendMessage(task.assignee, body, 'command');
    return `; asked ${task.assignee} to rebase`;
  } catch (e) {
    run.deps.err(`agentteams: warning: could not message ${task.assignee}: ${message(e)}`);
    return '';
  }
}

/** Merges each task branch in task order. Returns the clean merges and whether anything went wrong. */
async function mergeAll(run: Run, tasks: TaskView[], remote: string | null): Promise<{ merged: Merged[]; problems: boolean; stopped: boolean }> {
  const { deps, root, base, wt, opts } = run;
  const merged: Merged[] = [];
  let problems = false;
  for (const task of tasks) {
    const ref = task.branch ? await taskRef(deps, root, task.branch, remote) : null;
    if (!ref) {
      deps.out(`  ${label(task)}: branch ${task.branch ?? '(none recorded)'} not found; skipped`);
      problems = true;
      continue;
    }
    const res = await mergeRef(deps, wt, ref, `Merge task #${task.number}: ${task.title} (${task.branch})`, opts.stopOnConflict);
    if (res.ok) {
      merged.push({ task, files: await changedFiles(deps, root, base, ref) });
      deps.out(`  ${label(task)}: merged`);
      continue;
    }
    problems = true;
    if (res.conflicts.length === 0) {
      deps.out(`  ${label(task)}: merge failed (${res.error}); skipped`);
      continue;
    }
    const hits = merged.filter((m) => m.files.some((f) => res.conflicts.includes(f))).map((m) => `#${m.task.number}`);
    const partners = hits.length > 0 ? hits.join(', ') : `changes on ${base}`;
    const asked = await notifyConflict(run, task, partners, res.conflicts);
    deps.out(`  ${label(task)}: conflict with ${partners} in ${res.conflicts.join(', ')}; ${opts.stopOnConflict ? 'stopped' : 'skipped'}${asked}`);
    if (opts.stopOnConflict) return { merged, problems, stopped: true };
  }
  return { merged, problems, stopped: false };
}

function printTail(deps: CliDeps, r: { stdout: string; stderr: string }): void {
  const text = `${r.stdout}${r.stdout && !r.stdout.endsWith('\n') ? '\n' : ''}${r.stderr}`.trimEnd();
  for (const line of text.split('\n').slice(-TAIL_LINES)) if (line) deps.out(`  ${line}`);
}

/** Runs the test command (given, detected, or none) in the integration worktree. True when it passed or was skipped. */
async function runTests(deps: CliDeps, wt: string, test: string | false | undefined): Promise<boolean> {
  if (test === false) { deps.out('Skipping tests (--no-test).'); return true; }
  let cmd = test;
  let install: string | undefined;
  if (cmd === undefined) {
    const found = await detectTestCommand(wt);
    if (!found) {
      deps.out('No test command found (package.json test script, Makefile test target, Cargo, Go or pytest); skipping tests. Pass --test "<cmd>" to run one.');
      return true;
    }
    ({ test: cmd, install } = found);
    deps.out(`Tests: ${cmd} (from ${found.source})`);
  } else deps.out(`Tests: ${cmd}`);
  for (const step of [install, cmd]) {
    if (!step) continue;
    if (step === install) deps.out(`Installing dependencies first: ${install}`);
    const r = await deps.exec('sh', ['-c', step], { cwd: wt });
    printTail(deps, r);
    if (r.code !== 0) { deps.out(`Tests failed (${step} exited ${r.code}).`); return false; }
  }
  deps.out('Tests passed.');
  return true;
}

/** Fast-forwards the base in the main checkout when it is on the base and clean. Returns why not, or null. */
async function land(deps: CliDeps, root: string, base: string): Promise<{ reason: string; command: string } | null> {
  const ff = `git merge --ff-only ${INTEGRATION_BRANCH}`;
  if ((await currentBranch(deps, root)) !== base) return { reason: `${base} is not checked out in ${root}`, command: `git checkout ${base} && ${ff}` };
  const status = await deps.exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root });
  if (status.code !== 0 || status.stdout.trim()) return { reason: `${root} has uncommitted changes (commit or stash them first)`, command: ff };
  const r = await deps.exec('git', ['merge', '--ff-only', '--quiet', INTEGRATION_BRANCH], { cwd: root });
  return r.code === 0 ? null : { reason: gitFailure(['merge', '--ff-only', INTEGRATION_BRANCH], r).message, command: ff };
}

async function record(run: Run, merged: Merged[], remote: string | null): Promise<void> {
  const { deps, client, root, base, opts } = run;
  for (const { task } of merged) {
    try { await client.markMerged(task.number); } catch (e) { deps.err(`agentteams: warning: could not record task #${task.number} as merged: ${message(e)}`); }
  }
  deps.out(`Recorded ${merged.map((m) => `#${m.task.number}`).join(', ')} as merged.`);
  if (!opts.push) return;
  if (!remote) { deps.err('agentteams: warning: --push: this repo has no git remote'); return; }
  const r = await deps.exec('git', ['push', remote, base], { cwd: root });
  if (r.code !== 0) throw gitFailure(['push', remote, base], r);
  deps.out(`Pushed ${base} to ${remote}.`);
}

/** After clean merges: test, then land and record (or explain why not). Returns the exit code. */
async function finish(run: Run, merged: Merged[], problems: boolean, remote: string | null): Promise<number> {
  const { deps, root, base, wt, opts } = run;
  if (!(await runTests(deps, wt, opts.test))) {
    deps.out(`${base} is unchanged and nothing was recorded. The integration worktree is kept for a look: ${wt}`);
    return 1;
  }
  await removeIntegrationWorktree(deps, root, wt);
  if (opts.dryRun) {
    deps.out(`Dry run: ${base} is unchanged and nothing was recorded. The result is on branch ${INTEGRATION_BRANCH}.`);
    return problems ? 1 : 0;
  }
  const blocked = await land(deps, root, base);
  if (blocked) {
    deps.out(`Not landed: ${blocked.reason}. The result is on branch ${INTEGRATION_BRANCH}. To land it:`);
    deps.out(`  cd ${root} && ${blocked.command}`);
    deps.out(`  then record the merges: ${merged.map((m) => `agentteams merged ${m.task.number} --agent ${run.cred.tool}`).join(' && ')}`);
    return 1;
  }
  deps.out(`Fast-forwarded ${base} to the integration result.`);
  await record(run, merged, remote);
  return problems ? 1 : 0;
}

/** `agentteams merge`: merge every finished, unmerged task branch, test the result, and land it on the base. */
export async function mergeCommand(deps: CliDeps, opts: MergeOpts): Promise<number> {
  const { cred, client } = await orchestrator(deps, opts.agent);
  const root = await repoRootOf(deps);
  const base = await pickBase(deps, root, opts.into);
  const tasks = (await client.listTasks()).filter((t) => t.status === 'done' && !t.mergedAt).sort((a, b) => a.number - b.number);
  if (tasks.length === 0) { deps.out('No finished tasks to merge.'); return 0; }

  const remote = await fetchRemote(deps, root, cred);
  const wt = await createIntegrationWorktree(deps, root, base);
  const run: Run = { deps, client, cred, root, base, wt, opts };
  deps.out(`Merging ${tasks.length} finished task${tasks.length === 1 ? '' : 's'} into ${base} on branch ${INTEGRATION_BRANCH} (${wt}):`);
  const { merged, problems, stopped } = await mergeAll(run, tasks, remote);
  if (stopped) {
    deps.out(`Stopped at the conflict; ${base} is unchanged. Resolve it in ${wt}, or rerun without --stop-on-conflict.`);
    return 1;
  }
  if (merged.length === 0) {
    await removeIntegrationWorktree(deps, root, wt);
    deps.out(`Nothing merged cleanly; ${base} is unchanged.`);
    return 1;
  }
  return finish(run, merged, problems, remote);
}
