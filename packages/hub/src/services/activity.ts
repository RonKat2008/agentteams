import { ActivityQuery, type ActivityEvent, type ActivityType } from '@agentteams/shared';
import type { Actor, HubContext } from '../context.js';
import { parseInput } from '../errors.js';

export async function logEvent(
  ctx: HubContext,
  teamId: string,
  agentId: string | null,
  type: ActivityType,
  data: Record<string, unknown> = {},
): Promise<void> {
  await ctx.db.insertInto('activity').values({
    id: ctx.newId(),
    team_id: teamId,
    agent_id: agentId,
    type,
    data_json: JSON.stringify(data),
    created_at: ctx.now().toISOString(),
  }).execute();
}

export async function getActivity(ctx: HubContext, actor: Actor, input: ActivityQuery = {}): Promise<ActivityEvent[]> {
  const p = parseInput(ActivityQuery, input);
  let query = ctx.db.selectFrom('activity')
    .leftJoin('agents', 'agents.id', 'activity.agent_id')
    .select(['activity.id', 'activity.type', 'activity.data_json', 'activity.created_at', 'agents.name as agent'])
    .where('activity.team_id', '=', actor.teamId);
  if (p.since) query = query.where('activity.created_at', '>', new Date(p.since).toISOString());
  const rows = await query.orderBy('activity.id', 'desc').limit(p.limit).execute();
  return rows.reverse().map((r) => ({
    id: r.id,
    type: r.type,
    agent: r.agent ?? null,
    data: JSON.parse(r.data_json) as Record<string, unknown>,
    createdAt: r.created_at,
  }));
}
