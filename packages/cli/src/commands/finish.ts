import type { ToolKind } from '@agentteams/shared';
import type { CliDeps } from '../deps.js';
import { currentBranch } from '../git.js';
import { clientFor, requireCredential, teamDefaultBranch } from './shared.js';

export interface DoneOpts { summary: string; agent?: ToolKind }
export interface AgentOpts { agent?: ToolKind }
export interface MergedOpts { pr?: string; agent?: ToolKind }

const failure = (what: string, r: { code: number; stderr: string }): Error =>
  new Error(`${what} failed: ${r.stderr.trim() || `exit ${r.code}`}`);

export async function doneCommand(deps: CliDeps, task: number, opts: DoneOpts): Promise<void> {
  const cred = await requireCredential(deps, opts.agent);
  const client = clientFor(deps, cred);
  const branch = await currentBranch(deps, deps.cwd);
  const { branch: base, provider } = await teamDefaultBranch(deps, client, deps.cwd);
  if (branch === 'HEAD' || branch === base) throw new Error("run this on the task's branch (expected at/<agent>/<task>)");

  const status = await deps.exec('git', ['status', '--porcelain'], { cwd: deps.cwd });
  if (status.code === 0 && status.stdout.trim()) {
    deps.err('agentteams: warning: uncommitted changes are not included in the pushed branch');
  }

  if (provider === 'github') {
    const push = await deps.exec('git', ['push', '-u', 'origin', branch], { cwd: deps.cwd });
    if (push.code !== 0) throw failure(`git push -u origin ${branch}`, push);
  }

  await client.completeTask(task, opts.summary, branch);
  deps.out(`Task #${task} done on ${branch}. The orchestrator has been notified.`);
}

export async function prCommand(deps: CliDeps, task: number, opts: AgentOpts): Promise<void> {
  const cred = await requireCredential(deps, opts.agent);
  const client = clientFor(deps, cred);
  const { branch: base, provider } = await teamDefaultBranch(deps, client, deps.cwd);
  if (provider !== 'github') throw new Error('pr needs a GitHub-linked team');

  const view = await client.getTask(task);
  if (!view.branch) throw new Error(`task #${task} has no branch yet; the assignee runs agentteams done first`);

  const body = `${view.summary ?? ''}\n\nagentteams task #${task}`;
  const created = await deps.exec('gh', [
    'pr', 'create', '--base', base, '--head', view.branch, '--title', `#${task}: ${view.title}`, '--body', body,
  ], { cwd: deps.cwd });
  if (created.code === 0) {
    deps.out(created.stdout.trim());
    return;
  }
  if (/already exists/i.test(created.stderr)) {
    const existing = await deps.exec('gh', ['pr', 'view', view.branch, '--json', 'url', '-q', '.url'], { cwd: deps.cwd });
    if (existing.code === 0 && existing.stdout.trim()) {
      deps.out(existing.stdout.trim());
      return;
    }
  }
  throw failure('gh pr create', created);
}

export async function mergedCommand(deps: CliDeps, task: number, opts: MergedOpts): Promise<void> {
  const cred = await requireCredential(deps, opts.agent);
  await clientFor(deps, cred).markMerged(task, opts.pr);
  deps.out(`Recorded task #${task} as merged.`);
}
