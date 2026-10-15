import type { RepoLink } from '@agentteams/shared';
import type { Actor, HubContext } from '../context.js';
import type { TeamRow } from '../db/schema.js';
import { DomainError } from '../errors.js';

export async function getTeamRow(ctx: HubContext, teamId: string): Promise<TeamRow> {
  const team = await ctx.db.selectFrom('teams').selectAll().where('id', '=', teamId).executeTakeFirst();
  if (!team) throw new DomainError('not_found', 'team not found');
  return team;
}

export function repoOf(team: TeamRow): RepoLink {
  return {
    provider: team.repo_provider,
    ...(team.repo_slug ? { slug: team.repo_slug } : {}),
    defaultBranch: team.default_branch,
  };
}

export async function findAgent(ctx: HubContext, teamId: string, name: string): Promise<{ id: string; name: string }> {
  const agent = await ctx.db.selectFrom('agents').select(['id', 'name'])
    .where('team_id', '=', teamId).where('name', '=', name).executeTakeFirst();
  if (!agent) throw new DomainError('not_found', `no agent named "${name}" in this team`);
  return agent;
}

export async function agentNames(ctx: HubContext, teamId: string): Promise<Map<string, string>> {
  const rows = await ctx.db.selectFrom('agents').select(['id', 'name']).where('team_id', '=', teamId).execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function requireOrchestrator(ctx: HubContext, actor: Actor, action: string): Promise<void> {
  const team = await getTeamRow(ctx, actor.teamId);
  if (team.orchestrator_agent_id === actor.id) return;
  const orchestrator = team.orchestrator_agent_id
    ? (await agentNames(ctx, actor.teamId)).get(team.orchestrator_agent_id)
    : undefined;
  throw new DomainError('forbidden', `only the orchestrator${orchestrator ? ` (${orchestrator})` : ''} can ${action}`);
}

/** Creator powers belong to the creating agent (by id), not to a self-asserted member name. */
export async function requireCreator(ctx: HubContext, team: TeamRow, actor: Actor, action: string): Promise<void> {
  if (team.creator_agent_id === actor.id) return;
  const creator = (await agentNames(ctx, team.id)).get(team.creator_agent_id) ?? team.created_by_member;
  throw new DomainError('forbidden', `only the team creator (${creator}) can ${action}`);
}
