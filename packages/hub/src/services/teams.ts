import {
  CreateTeamInput, INVITE_TTL_MS, InvitePreviewInput, JoinTeamInput, SetOrchestratorInput, presenceOf,
  type InvitePreview, type TeamStatus,
} from '@agentteams/shared';
import { withTx, type Actor, type HubContext } from '../context.js';
import type { TeamRow } from '../db/schema.js';
import { DomainError, parseInput } from '../errors.js';
import { generateApiKey, generateInviteCode, hashSecret, normalizeInviteCode } from '../secrets.js';
import { logEvent } from './activity.js';
import { findAgent, getTeamRow, repoOf, requireCreator } from './lookup.js';

function inviteExpiry(ctx: HubContext): string {
  return new Date(ctx.now().getTime() + INVITE_TTL_MS).toISOString();
}

async function uniqueAgentName(ctx: HubContext, teamId: string, base: string): Promise<string> {
  const rows = await ctx.db.selectFrom('agents').select('name')
    .where('team_id', '=', teamId)
    .where((eb) => eb.or([eb('name', '=', base), eb('name', 'like', `${base}-%`)]))
    .execute();
  const taken = new Set(rows.map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
}

export async function createTeam(ctx: HubContext, input: CreateTeamInput) {
  const p = parseInput(CreateTeamInput, input);
  const inviteCode = generateInviteCode();
  const apiKey = generateApiKey();
  const teamId = ctx.newId();
  const agentId = ctx.newId();
  const agentName = `${p.member}-${p.tool}`;
  const nowIso = ctx.now().toISOString();
  const inviteExpiresAt = inviteExpiry(ctx);

  await withTx(ctx, async (tx) => {
    await tx.db.insertInto('teams').values({
      id: teamId, name: p.name,
      invite_code_hash: hashSecret(normalizeInviteCode(inviteCode)),
      invite_expires_at: inviteExpiresAt, invite_revoked: 0,
      repo_provider: p.repo.provider, repo_slug: p.repo.slug ?? null, default_branch: p.repo.defaultBranch,
      orchestrator_agent_id: agentId, created_by_member: p.member, creator_agent_id: agentId, created_at: nowIso,
    }).execute();
    await tx.db.insertInto('agents').values({
      id: agentId, team_id: teamId, name: agentName, member: p.member, tool: p.tool,
      api_key_hash: hashSecret(apiKey), last_seen_at: nowIso, created_at: nowIso,
    }).execute();
    await logEvent(tx, teamId, agentId, 'team_created', { name: p.name, repo: p.repo });
    await logEvent(tx, teamId, agentId, 'agent_joined', { agent: agentName, member: p.member, tool: p.tool });
  });

  return { teamId, teamName: p.name, agentName, apiKey, inviteCode, inviteExpiresAt };
}

async function findInvitedTeam(ctx: HubContext, inviteCode: string): Promise<TeamRow> {
  const team = await ctx.db.selectFrom('teams').selectAll()
    .where('invite_code_hash', '=', hashSecret(normalizeInviteCode(inviteCode)))
    .executeTakeFirst();
  if (!team) throw new DomainError('not_found', 'invite code not recognised');
  if (team.invite_revoked === 1 || team.invite_expires_at <= ctx.now().toISOString()) {
    throw new DomainError('forbidden', 'invite code has expired or been revoked; ask the team creator for a new one');
  }
  return team;
}

/** Validates an invite exactly as joinTeam does, but creates nothing. Needs no auth. */
export async function previewInvite(ctx: HubContext, input: InvitePreviewInput): Promise<InvitePreview> {
  const p = parseInput(InvitePreviewInput, input);
  const team = await findInvitedTeam(ctx, p.inviteCode);
  return { teamName: team.name, repo: repoOf(team) };
}

export async function joinTeam(ctx: HubContext, input: JoinTeamInput) {
  const p = parseInput(JoinTeamInput, input);
  const team = await findInvitedTeam(ctx, p.inviteCode);

  const apiKey = generateApiKey();
  const agentId = ctx.newId();
  const nowIso = ctx.now().toISOString();
  const agentName = await withTx(ctx, async (tx) => {
    const name = await uniqueAgentName(tx, team.id, `${p.member}-${p.tool}`);
    await tx.db.insertInto('agents').values({
      id: agentId, team_id: team.id, name, member: p.member, tool: p.tool,
      api_key_hash: hashSecret(apiKey), last_seen_at: nowIso, created_at: nowIso,
    }).execute();
    await logEvent(tx, team.id, agentId, 'agent_joined', { agent: name, member: p.member, tool: p.tool });
    return name;
  });

  return { teamId: team.id, teamName: team.name, agentName, apiKey, repo: repoOf(team) };
}

/** Resolves an API key to its agent and records a heartbeat. */
export async function authenticate(ctx: HubContext, apiKey: string): Promise<Actor> {
  const row = await ctx.db.selectFrom('agents').select(['id', 'team_id', 'name', 'member', 'tool'])
    .where('api_key_hash', '=', hashSecret(apiKey)).executeTakeFirst();
  if (!row) throw new DomainError('unauthorized', 'invalid API key');
  await ctx.db.updateTable('agents').set({ last_seen_at: ctx.now().toISOString() }).where('id', '=', row.id).execute();
  return { id: row.id, teamId: row.team_id, name: row.name, member: row.member, tool: row.tool };
}

export async function getTeamStatus(ctx: HubContext, actor: Actor): Promise<TeamStatus> {
  const team = await getTeamRow(ctx, actor.teamId);
  const now = ctx.now();
  const agents = await ctx.db.selectFrom('agents').selectAll()
    .where('team_id', '=', team.id).orderBy('created_at').orderBy('id').execute();
  const openTasks = await ctx.db.selectFrom('tasks')
    .select(['number', 'title', 'status', 'assignee_agent_id'])
    .where('team_id', '=', team.id).where('status', 'in', ['assigned', 'in_progress', 'blocked'])
    .orderBy('updated_at', 'desc').execute();
  const claims = await ctx.db.selectFrom('claims').select(['agent_id', 'glob'])
    .where('team_id', '=', team.id).where('expires_at', '>', now.toISOString()).orderBy('glob').execute();

  return {
    team: {
      name: team.name,
      repo: repoOf(team),
      orchestrator: agents.find((a) => a.id === team.orchestrator_agent_id)?.name ?? null,
    },
    agents: agents.map((a) => {
      const mine = openTasks.filter((t) => t.assignee_agent_id === a.id);
      const current = mine.find((t) => t.status === 'in_progress') ?? mine[0] ?? null;
      return {
        name: a.name,
        member: a.member,
        tool: a.tool,
        presence: presenceOf(a.last_seen_at, now),
        lastSeenAt: a.last_seen_at,
        isOrchestrator: a.id === team.orchestrator_agent_id,
        currentTask: current ? { number: current.number, title: current.title, status: current.status } : null,
        claims: claims.filter((c) => c.agent_id === a.id).map((c) => c.glob),
      };
    }),
  };
}

export async function setOrchestrator(ctx: HubContext, actor: Actor, input: SetOrchestratorInput) {
  const p = parseInput(SetOrchestratorInput, input);
  const team = await getTeamRow(ctx, actor.teamId);
  await requireCreator(ctx, team, actor, 'change the orchestrator');
  const target = await findAgent(ctx, team.id, p.agent);
  await withTx(ctx, async (tx) => {
    await tx.db.updateTable('teams').set({ orchestrator_agent_id: target.id }).where('id', '=', team.id).execute();
    await logEvent(tx, team.id, actor.id, 'orchestrator_changed', { to: target.name });
  });
  return { orchestrator: target.name };
}

export async function rotateInvite(ctx: HubContext, actor: Actor) {
  const team = await getTeamRow(ctx, actor.teamId);
  await requireCreator(ctx, team, actor, 'rotate the invite code');
  const inviteCode = generateInviteCode();
  const inviteExpiresAt = inviteExpiry(ctx);
  await withTx(ctx, async (tx) => {
    await tx.db.updateTable('teams').set({
      invite_code_hash: hashSecret(normalizeInviteCode(inviteCode)),
      invite_expires_at: inviteExpiresAt,
      invite_revoked: 0,
    }).where('id', '=', team.id).execute();
    await logEvent(tx, team.id, actor.id, 'invite_rotated', { expiresAt: inviteExpiresAt });
  });
  return { inviteCode, inviteExpiresAt };
}

export async function revokeInvite(ctx: HubContext, actor: Actor) {
  const team = await getTeamRow(ctx, actor.teamId);
  await requireCreator(ctx, team, actor, 'revoke the invite code');
  await withTx(ctx, async (tx) => {
    await tx.db.updateTable('teams').set({ invite_revoked: 1 }).where('id', '=', team.id).execute();
    await logEvent(tx, team.id, actor.id, 'invite_revoked');
  });
  return { revoked: true as const };
}
