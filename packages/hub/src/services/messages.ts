import { MarkReadInput, ReadInboxInput, SendMessageInput, type InboxMessage, type MessageKind } from '@agentteams/shared';
import { withTx, type Actor, type HubContext } from '../context.js';
import { DomainError, parseInput } from '../errors.js';
import { logEvent } from './activity.js';
import { findAgent, getTeamRow, requireOrchestrator } from './lookup.js';

const INBOX_PAGE = 100;
const PREVIEW_LENGTH = 80;

export async function insertMessage(
  ctx: HubContext,
  m: { teamId: string; fromId: string; toId: string | null; kind: MessageKind; body: string },
): Promise<string> {
  const id = ctx.newId();
  const team = await getTeamRow(ctx, m.teamId);
  const fromRole = m.fromId === team.orchestrator_agent_id ? 'orchestrator' : 'peer';
  await ctx.db.insertInto('messages').values({
    id, team_id: m.teamId, from_agent_id: m.fromId, to_agent_id: m.toId,
    from_role: fromRole, kind: m.kind, body: m.body, created_at: ctx.now().toISOString(),
  }).execute();
  return id;
}

export async function sendMessage(ctx: HubContext, actor: Actor, input: SendMessageInput) {
  const p = parseInput(SendMessageInput, input);
  if (p.kind === 'command') await requireOrchestrator(ctx, actor, 'send commands');
  let toId: string | null = null;
  if (p.to !== 'all') {
    if (p.to === actor.name) throw new DomainError('invalid', 'you cannot message yourself');
    toId = (await findAgent(ctx, actor.teamId, p.to)).id;
  }
  const id = await withTx(ctx, async (tx) => {
    const messageId = await insertMessage(tx, { teamId: actor.teamId, fromId: actor.id, toId, kind: p.kind, body: p.body });
    await logEvent(tx, actor.teamId, actor.id, 'message_sent', {
      to: p.to, kind: p.kind, preview: p.body.slice(0, PREVIEW_LENGTH), body: p.body,
    });
    return messageId;
  });
  return { id, to: p.to };
}

export async function readInbox(ctx: HubContext, actor: Actor, input: ReadInboxInput = {}): Promise<InboxMessage[]> {
  const p = parseInput(ReadInboxInput, input);

  const rows = await ctx.db.selectFrom('messages as m')
    .innerJoin('agents as a', 'a.id', 'm.from_agent_id')
    .leftJoin('message_reads as r', (join) => join.onRef('r.message_id', '=', 'm.id').on('r.agent_id', '=', actor.id))
    .select(['m.id', 'm.kind', 'm.body', 'm.created_at', 'm.to_agent_id', 'm.from_role', 'a.name as from_name'])
    .where('m.team_id', '=', actor.teamId)
    .where('m.from_agent_id', '!=', actor.id)
    .where('r.message_id', 'is', null)
    .where((eb) => eb.or([
      eb('m.to_agent_id', '=', actor.id),
      eb.and([eb('m.to_agent_id', 'is', null), eb('m.id', '>', actor.id)]),
    ]))
    .orderBy('m.id')
    .limit(Math.min(p.limit ?? INBOX_PAGE, INBOX_PAGE))
    .execute();

  if (p.markRead) await insertReads(ctx, actor, rows.map((r) => r.id));

  return rows.map((r) => ({
    id: r.id,
    from: r.from_name,
    fromRole: r.from_role,
    to: r.to_agent_id ? actor.name : 'all',
    kind: r.kind,
    body: r.body,
    createdAt: r.created_at,
  }));
}

async function insertReads(ctx: HubContext, actor: Actor, messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  const readAt = ctx.now().toISOString();
  await ctx.db.insertInto('message_reads')
    .values(messageIds.map((id) => ({ message_id: id, agent_id: actor.id, read_at: readAt })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/**
 * Marks specific messages read for the actor: the replicated form of readInbox's markRead side effect.
 * Only unread messages readInbox would show the actor are marked (other ids are ignored) and re-marking
 * is a no-op, so the op is idempotent and replays the same way in any state.
 */
export async function markRead(ctx: HubContext, actor: Actor, input: MarkReadInput): Promise<{ marked: number }> {
  const p = parseInput(MarkReadInput, input);
  const ids = [...new Set(p.messageIds)];
  return withTx(ctx, async (tx) => {
    const visible = await tx.db.selectFrom('messages as m')
      .leftJoin('message_reads as r', (join) => join.onRef('r.message_id', '=', 'm.id').on('r.agent_id', '=', actor.id))
      .select('m.id')
      .where('m.id', 'in', ids)
      .where('m.team_id', '=', actor.teamId)
      .where('m.from_agent_id', '!=', actor.id)
      .where('r.message_id', 'is', null)
      .where((eb) => eb.or([
        eb('m.to_agent_id', '=', actor.id),
        eb.and([eb('m.to_agent_id', 'is', null), eb('m.id', '>', actor.id)]),
      ]))
      .orderBy('m.id')
      .execute();
    await insertReads(tx, actor, visible.map((r) => r.id));
    return { marked: visible.length };
  });
}
