import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestContext, seedTeam, type TestEnv } from './helpers.js';
import { getActivity, logEvent } from '../src/services/activity.js';
import { setOrchestrator } from '../src/services/teams.js';

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
