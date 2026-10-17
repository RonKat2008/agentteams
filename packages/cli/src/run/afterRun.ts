import type { TaskView } from '@agentteams/shared';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { oneLine } from '../format.js';
import { pickRemote } from '../merge/integrate.js';
import type { TeamClient } from '../teamClient.js';
import { commitsItself, type RunnableTool } from './agentCommands.js';

const TITLE_CAP = 72;

export interface FinishedRun { cred: Credential; tool: RunnableTool; client: TeamClient; task: TaskView; path: string; branch: string; root: string; log: string }

const git = (deps: CliDeps, cwd: string, args: string[]) => deps.exec('git', args, { cwd });
const firstLine = (r: { code: number; stderr: string; stdout: string }): string =>
  (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}`;

/** `task #<n>: <title>` on one line: the title is teammate-written, so control and format characters are dropped. */
export function taskCommitMessage(task: TaskView): string {
  const title = oneLine(task.title).replace(/\s+/g, ' ').trim().slice(0, TITLE_CAP);
  return title ? `task #${task.number}: ${title}` : `task #${task.number}`;
}

/**
 * Outside any sandbox, as the user: commits whatever the tool left in the worktree on the task branch (git hooks run
 * as for any commit). Tools that commit themselves only get a warning about leftovers.
 */
async function commitLeftovers(deps: CliDeps, r: FinishedRun): Promise<void> {
  const status = await git(deps, r.path, ['status', '--porcelain']);
  if (status.code !== 0) { deps.err(`agentteams: warning: git status failed in ${r.path}: ${firstLine(status)}`); return; }
  if (!status.stdout.trim()) return;
  if (commitsItself(r.tool)) {
    deps.err(`agentteams: warning: ${r.path} has uncommitted changes the agent did not commit; commit them there yourself`);
    return;
  }
  const message = taskCommitMessage(r.task);
  const added = await git(deps, r.path, ['add', '-A']);
  const committed = added.code === 0 ? await git(deps, r.path, ['commit', '-q', '-m', message]) : added;
  if (committed.code !== 0) {
    deps.err(`agentteams: could not commit the changes in ${r.path} (${firstLine(committed)}); commit them there yourself`);
    return;
  }
  deps.out(`Committed the changes in ${r.path} on ${r.branch}: "${message}"`);
}

/** Says whether the agent completed the task, and what to do next. */
async function report(deps: CliDeps, r: FinishedRun): Promise<void> {
  const n = r.task.number;
  const view = await r.client.getTask(n).catch(() => null);
  if (view?.status === 'done') {
    deps.out(`Task #${n} is done on ${r.branch}.`);
    const remote = await pickRemote(deps, r.root, r.cred.git?.remote);
    if (remote) deps.out(`For teammates on other computers, push it: git -C ${r.path} push -u ${remote} ${r.branch}`);
    return;
  }
  deps.out(`Task #${n} is not done: ${r.cred.agentName} did not call complete_task. Read the log: ${r.log}`);
  deps.out(`When the work is finished: cd ${r.path} && agentteams done ${n} -m "<summary>" --agent ${r.tool}`);
  deps.out(`To start it again: agentteams run ${n} --agent ${r.tool}`);
}

/** After the tool exits (foreground, or in the background supervisor): commit its changes and report. */
export async function afterRun(deps: CliDeps, r: FinishedRun): Promise<void> {
  await commitLeftovers(deps, r);
  await report(deps, r);
}
