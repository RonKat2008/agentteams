import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestContext, seedTeam, type TestEnv } from './helpers.js';
import { getActivity, logEvent } from '../src/services/activity.js';
import { setOrchestrator } from '../src/services/teams.js';
import { claimTask, createTask, updateTask } from '../src/services/tasks.js';

let env: TestEnv;
beforeEach(async () => { env = await makeTestContext(); });
afterEach(async () => { await env.close(); });

describe('activity log', () => {
  it('records team creation and joins in order with agent names', async () => {
    const { ronit } = await seedTeam(env);
    const events = await getActivity(env.ctx, ronit);
    expect(events.map((e) => [e.type, e.agent])).toEqual([
      ['team_created', 'ronit-claude'],
      ['agent_joined', 'ronit-claude'],
      ['agent_joined', 'dylan-claude'],
      ['agent_joined', 'ash-codex'],
    ]);
    expect(events[0]!.data).toMatchObject({ name: 'dev-squad' });
  });

  it('returns only the last `limit` events, still chronological', async () => {
    const { ronit } = await seedTeam(env);
    await setOrchestrator(env.ctx, ronit, { agent: 'ash-codex' });
    const events = await getActivity(env.ctx, ronit, { limit: 2 });
    expect(events.map((e) => e.type)).toEqual(['agent_joined', 'orchestrator_changed']);
  });

  it('filters by since, accepting timestamps without milliseconds', async () => {
    const { ronit } = await seedTeam(env); // seeded at 00:00:00.000
    env.advance(500);
    await logEvent(env.ctx, ronit.teamId, ronit.id, 'merged', { task: 1 });
    const events = await getActivity(env.ctx, ronit, { since: '2026-01-01T00:00:00Z' });
    expect(events.map((e) => e.type)).toEqual(['merged']);
  });

  it("never shows another team's events", async () => {
    const { ronit } = await seedTeam(env);
    await seedTeam(env); // a second, independent team in the same database
    expect(await getActivity(env.ctx, ronit)).toHaveLength(4);
  });
});

describe('activity log: no duplicate task events', () => {
  const taskTypes = async (actor: Parameters<typeof getActivity>[1]) =>
    (await getActivity(env.ctx, actor)).map((e) => e.type).filter((t) => t.startsWith('task_'));

  it('logs one "started" when the assignee claims the same task twice', async () => {
    const { ronit, dylan } = await seedTeam(env);
    await createTask(env.ctx, ronit, { title: 'first', description: '', assignee: 'dylan-claude' });
    await claimTask(env.ctx, dylan, { task: 1 });
    await claimTask(env.ctx, dylan, { task: 1 }); // e.g. `agentteams worktree` then the MCP claim_task
    expect(await taskTypes(ronit)).toEqual(['task_created', 'task_claimed']);
  });

  it('keeps a status update after the claim as its own event', async () => {
    const { ronit, dylan } = await seedTeam(env);
    await createTask(env.ctx, ronit, { title: 'first', description: '', assignee: 'dylan-claude' });
    await claimTask(env.ctx, dylan, { task: 1 });
    await updateTask(env.ctx, dylan, { task: 1, status: 'in_progress', note: 'going' });
    expect(await taskTypes(ronit)).toEqual(['task_created', 'task_claimed', 'task_updated']);
  });
});
