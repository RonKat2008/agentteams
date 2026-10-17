/**
 * Bootstrap services for the git transport's replicated op log. They replace createTeam/joinTeam there:
 * no invite codes and no API keys (identity is the agent's signing key, carried in the op), and every id
 * and timestamp comes from the op, so replay produces identical rows on every replica.
 */
import { ReplicatedCreateTeamInput, ReplicatedJoinInput } from '@agentteams/shared';
import { withTx, type HubContext } from '../context.js';
import { DomainError, parseInput } from '../errors.js';
import { logEvent } from './activity.js';
import { uniqueAgentName } from './teams.js';

/**
 * Placeholder secrets for replicated rows. hashSecret() yields 64 hex characters, so these can never
 * match an invite code or API key: replicated teams and agents cannot be joined or authenticated over HTTP.
 */
const inviteHashOf = (teamId: string): string => `replica:${teamId}`;
const apiKeyHashOf = (agentId: string): string => `replica:${agentId}`;

function requireSelf(authorId: string, agentId: string): void {
  if (authorId !== agentId) throw new DomainError('forbidden', 'an agent can only register its own key');
}

/**
 * The team's first op. Valid once per replicated view: any existing team makes it a rejected op, so the
 * first createTeam in total order wins on every replica.
 */
export async function createReplicatedTeam(
  ctx: HubContext, authorId: string, input: ReplicatedCreateTeamInput,
): Promise<{ teamId: string; agentName: string }> {
  const p = parseInput(ReplicatedCreateTeamInput, input);
  requireSelf(authorId, p.agentId);
  const nowIso = ctx.now().toISOString();
  await withTx(ctx, async (tx) => {
    const existing = await tx.db.selectFrom('teams').select('id').limit(1).executeTakeFirst();
    if (existing) throw new DomainError('conflict', 'the team already exists; createTeam is valid only once');
    const keyed = await tx.db.selectFrom('agent_keys').select('agent_id').where('agent_id', '=', p.agentId).executeTakeFirst();
    if (keyed) throw new DomainError('conflict', 'this agent is already registered');
    await tx.db.insertInto('teams').values({
      id: p.teamId, name: p.name,
      invite_code_hash: inviteHashOf(p.teamId), invite_expires_at: nowIso, invite_revoked: 1,
      repo_provider: p.repo.provider, repo_slug: p.repo.slug ?? null, default_branch: p.repo.defaultBranch,
      orchestrator_agent_id: p.agentId, created_by_member: p.member, creator_agent_id: p.agentId, created_at: nowIso,
    }).execute();
    await insertAgent(tx, p.teamId, p, nowIso);
    await logEvent(tx, p.teamId, p.agentId, 'team_created', { name: p.name, repo: p.repo });
    await logEvent(tx, p.teamId, p.agentId, 'agent_joined', { agent: p.agentName, member: p.member, tool: p.tool, githubLogin: null });
  });
  return { teamId: p.teamId, agentName: p.agentName };
}

/**
 * An agent's first op. A second registration of the same agent id with a different key is rejected;
 * re-registering the identical key is an idempotent no-op. A join is never rejected over its name: if the
 * requested name is taken, the agent gets the first free `<name>-2`, `-3`, ... (as joinTeam does), which
 * is deterministic because replay applies joins in total order.
 */
export async function registerReplicatedAgent(
  ctx: HubContext, authorId: string, input: ReplicatedJoinInput,
): Promise<{ agentName: string; alreadyRegistered: boolean }> {
  const p = parseInput(ReplicatedJoinInput, input);
  requireSelf(authorId, p.agentId);
  const nowIso = ctx.now().toISOString();
  return withTx(ctx, async (tx) => {
    const team = await tx.db.selectFrom('teams').select('id').where('id', '=', p.teamId).executeTakeFirst();
    if (!team) throw new DomainError('not_found', 'team not found');
    const key = await tx.db.selectFrom('agent_keys').selectAll().where('agent_id', '=', p.agentId).executeTakeFirst();
    if (key) {
      if (key.public_key !== p.publicKey || key.team_id !== p.teamId) {
        throw new DomainError('conflict', 'this agent is already registered with a different key');
      }
      const current = await tx.db.selectFrom('agents').select('name').where('id', '=', p.agentId).executeTakeFirst();
      return { agentName: current?.name ?? p.agentName, alreadyRegistered: true };
    }
    const row = await tx.db.selectFrom('agents').select('id').where('id', '=', p.agentId).executeTakeFirst();
    if (row) throw new DomainError('conflict', 'this agent is already registered');
    const agentName = await uniqueAgentName(tx, p.teamId, p.agentName);
    await insertAgent(tx, p.teamId, { ...p, agentName }, nowIso);
    await logEvent(tx, p.teamId, p.agentId, 'agent_joined', { agent: agentName, member: p.member, tool: p.tool, githubLogin: null });
    return { agentName, alreadyRegistered: false };
  });
}

async function insertAgent(
  tx: HubContext, teamId: string,
  p: { agentId: string; agentName: string; member: string; tool: ReplicatedJoinInput['tool']; publicKey: string },
  nowIso: string,
): Promise<void> {
  await tx.db.insertInto('agents').values({
    id: p.agentId, team_id: teamId, name: p.agentName, member: p.member, tool: p.tool,
    // last_seen_at starts at the registration time; presence (not an op) updates it outside replay.
    api_key_hash: apiKeyHashOf(p.agentId), last_seen_at: nowIso, created_at: nowIso, github_login: null, github_id: null,
  }).execute();
  await tx.db.insertInto('agent_keys').values({
    agent_id: p.agentId, team_id: teamId, public_key: p.publicKey, registered_op_id: p.agentId, // bootstrap ops have op.id === op.agent === agentId
  }).execute();
}
