import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestContext, seedTeam, type TestEnv } from './helpers.js';
import { assignTask, claimTask, completeTask, createTask, listTasks, markMerged, updateTask } from '../src/services/tasks.js';
import { readInbox } from '../src/services/messages.js';
import { getTeamStatus } from '../src/services/teams.js';
import { getActivity } from '../src/services/activity.js';

let env: TestEnv;
beforeEach(async () => { env = await makeTestContext(); });
afterEach(async () => { await env.close(); });

describe('createTask', () => {
  it('numbers tasks per team starting at 1', async () => {
    const { ronit } = await seedTeam(env);
    const a = await createTask(env.ctx, ronit, { title: 'Login page' });
    const b = await createTask(env.ctx, ronit, { title: 'Signup page' });
    expect([a.number, a.status, b.number]).toEqual([1, 'open', 2]);
  });

  it('is orchestrator-only and names the orchestrator in the error', async () => {
    const { dylan } = await seedTeam(env);
    await expect(createTask(env.ctx, dylan, { title: 'x' })).rejects.toMatchObject({
      code: 'forbidden', message: 'only the orchestrator (ronit-claude) can create tasks',
    });
  });

  it('assigning on create sends the assignee a command', async () => {
    const { ronit, ash } = await seedTeam(env);
    const t = await createTask(env.ctx, ronit, { title: 'Login page', assignee: 'ash-codex' });
    expect([t.status, t.assignee]).toEqual(['assigned', 'ash-codex']);
    const inbox = await readInbox(env.ctx, ash);
    expect(inbox).toEqual([expect.objectContaining({ kind: 'command', fromRole: 'orchestrator', body: expect.stringContaining('Task #1') })]);
  });

  it('reports an unknown assignee', async () => {
    const { ronit } = await seedTeam(env);
    await expect(createTask(env.ctx, ronit, { title: 'x', assignee: 'ghost-codex' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('claim, update, complete', () => {
  it('lets the assignee work the task through to done', async () => {
    const { ronit, ash } = await seedTeam(env);
    await createTask(env.ctx, ronit, { title: 'Login page', assignee: 'ash-codex' });
    expect((await claimTask(env.ctx, ash, { task: 1 })).status).toBe('in_progress');
    expect((await updateTask(env.ctx, ash, { task: 1, status: 'blocked', note: 'need API keys' })).status).toBe('blocked');
    const done = await completeTask(env.ctx, ash, { task: 1, summary: 'Added /login', branch: 'at/ash-codex/1' });
    expect([done.status, done.branch, done.summary]).toEqual(['done', 'at/ash-codex/1', 'Added /login']);
    const orchestratorInbox = await readInbox(env.ctx, ronit);
    expect(orchestratorInbox.at(-1)).toMatchObject({ kind: 'fyi', from: 'ash-codex', body: expect.stringContaining('Task #1 done') });
  });

  it('lets anyone claim an unassigned task', async () => {
    const { ronit, dylan } = await seedTeam(env);
    await createTask(env.ctx, ronit, { title: 'Docs' });
    expect(await claimTask(env.ctx, dylan, { task: 1 })).toMatchObject({ assignee: 'dylan-claude', status: 'in_progress' });
  });

  it('stops others from claiming, updating or completing an assigned task', async () => {
    const { ronit, dylan } = await seedTeam(env);
    await createTask(env.ctx, ronit, { title: 'Login', assignee: 'ash-codex' });
    await expect(claimTask(env.ctx, dylan, { task: 1 })).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('ash-codex') });
    await expect(updateTask(env.ctx, dylan, { task: 1, note: 'hi' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(completeTask(env.ctx, dylan, { task: 1, summary: 's', branch: 'b' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses to change a finished task', async () => {
    const { ronit, ash } = await seedTeam(env);
    await createTask(env.ctx, ronit, { title: 'Login', assignee: 'ash-codex' });
    await completeTask(env.ctx, ash, { task: 1, summary: 's', branch: 'b' });
    await expect(completeTask(env.ctx, ash, { task: 1, summary: 's', branch: 'b' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(assignTask(env.ctx, ronit, { task: 1, assignee: 'dylan-claude' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(claimTask(env.ctx, ash, { task: 1 })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const { ronit, dylan, ash } = await seedTeam(env);
    await createTask(env.ctx, ronit, { title: 'Docs' });
    const results = await Promise.allSettled([claimTask(env.ctx, dylan, { task: 1 }), claimTask(env.ctx, ash, { task: 1 })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: 'forbidden' });
  });

  it('reports unknown task numbers', async () => {
    const { ash } = await seedTeam(env);
    await expect(claimTask(env.ctx, ash, { task: 99 })).rejects.toMatchObject({ code: 'not_found', message: 'task #99 not found' });
  });
});

describe('assignTask and listTasks', () => {
  it('reassigns and notifies the new assignee', async () => {
    const { ronit, dylan } = await seedTeam(env);
    await createTask(env.ctx, ronit, { title: 'Login', assignee: 'ash-codex' });
    const t = await assignTask(env.ctx, ronit, { task: 1, assignee: 'dylan-claude' });
    expect([t.assignee, t.status]).toEqual(['dylan-claude', 'assigned']);
    expect(await readInbox(env.ctx, dylan)).toHaveLength(1);
  });

  it('tells the previous assignee to stop and release files', async () => {
    const { ronit, ash } = await seedTeam(env);
    await createTask(env.ctx, ronit, { title: 'Login', assignee: 'ash-codex' });
    await readInbox(env.ctx, ash);
    await assignTask(env.ctx, ronit, { task: 1, assignee: 'dylan-claude' });
    expect(await readInbox(env.ctx, ash)).toEqual([
      expect.objectContaining({
        kind: 'command', fromRole: 'orchestrator',
        body: expect.stringContaining('Task #1 (Login) has been reassigned to dylan-claude. Stop work on it and release any files you claimed for it.'),
      }),
    ]);
  });

  it('filters by status and assignee', async () => {
    const { ronit, ash } = await seedTeam(env);
    await createTask(env.ctx, ronit, { title: 'A', assignee: 'ash-codex' });
    await createTask(env.ctx, ronit, { title: 'B' });
    await claimTask(env.ctx, ash, { task: 1 });
    expect((await listTasks(env.ctx, ash, { status: 'in_progress' })).map((t) => t.title)).toEqual(['A']);
    expect((await listTasks(env.ctx, ash, { assignee: 'ash-codex' })).map((t) => t.title)).toEqual(['A']);
    expect((await listTasks(env.ctx, ash)).map((t) => t.number)).toEqual([1, 2]);
  });

  it('shows the current task in team status and logs every step', async () => {
    const { ronit, ash } = await seedTeam(env);
    await createTask(env.ctx, ronit, { title: 'Login', assignee: 'ash-codex' });
    await claimTask(env.ctx, ash, { task: 1 });
    const status = await getTeamStatus(env.ctx, ronit);
    expect(status.agents.find((a) => a.name === 'ash-codex')!.currentTask).toEqual({ number: 1, title: 'Login', status: 'in_progress' });
    const types = (await getActivity(env.ctx, ronit)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['task_created', 'task_claimed']));
  });
});

describe('markMerged', () => {
  async function doneTask() {
    const team = await seedTeam(env);
    await createTask(env.ctx, team.ronit, { title: 'Login page', assignee: 'ash-codex' });
    await claimTask(env.ctx, team.ash, { task: 1 });
    return team;
  }

  it('is orchestrator-only', async () => {
    const { dylan } = await doneTask();
    await expect(markMerged(env.ctx, dylan, { task: 1 })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('requires the task to be done', async () => {
    const { ronit } = await doneTask();
    await expect(markMerged(env.ctx, ronit, { task: 1 })).rejects.toMatchObject({
      code: 'conflict', message: 'task #1 is not done yet',
    });
  });

  it('sets mergedAt, logs a merged event and tells the assignee', async () => {
    const { ronit, ash } = await doneTask();
    await completeTask(env.ctx, ash, { task: 1, summary: 'done', branch: 'at/ash-codex/1' });
    await readInbox(env.ctx, ash);
    const view = await markMerged(env.ctx, ronit, { task: 1, pr: 'https://github.com/o/r/pull/3' });
    expect(view.mergedAt).toBe('2026-01-01T00:00:00.000Z');
    const ev = (await getActivity(env.ctx, ronit)).filter((e) => e.type === 'merged');
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toEqual({ task: 1, branch: 'at/ash-codex/1', pr: 'https://github.com/o/r/pull/3' });
    const inbox = await readInbox(env.ctx, ash);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: 'fyi' });
    expect(inbox[0]!.body).toBe('Task #1 (Login page) was merged: https://github.com/o/r/pull/3. You can delete its worktree.');
  });

  it('refuses a second merge', async () => {
    const { ronit, ash } = await doneTask();
    await completeTask(env.ctx, ash, { task: 1, summary: 'done', branch: 'at/ash-codex/1' });
    await markMerged(env.ctx, ronit, { task: 1 });
    await expect(markMerged(env.ctx, ronit, { task: 1 })).rejects.toMatchObject({
      code: 'conflict', message: 'task #1 is already merged',
    });
  });

  it('exposes mergedAt as null on unmerged tasks', async () => {
    const { ronit } = await doneTask();
    expect((await listTasks(env.ctx, ronit))[0]!.mergedAt).toBeNull();
  });
});
