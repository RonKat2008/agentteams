import picomatch from 'picomatch';
import {
  ClaimFilesInput, ReleaseFilesInput, WhoOwnsInput, type ClaimResult, type ClaimView,
} from '@agentteams/shared';
import { withTx, type Actor, type HubContext } from '../context.js';
import { parseInput } from '../errors.js';
import { logEvent } from './activity.js';

const MS_PER_MIN = 60_000;

export function globMatches(glob: string, path: string): boolean {
  return picomatch(glob, { dot: true })(path);
}

/** Approximate overlap test between two globs (advisory claims only). */
export function globsOverlap(a: string, b: string): boolean {
  return a === b || globMatches(a, b) || globMatches(b, a);
}

export async function listActiveClaims(ctx: HubContext, teamId: string): Promise<Array<ClaimView & { agentId: string }>> {
  const rows = await ctx.db.selectFrom('claims')
    .innerJoin('agents', 'agents.id', 'claims.agent_id')
    .select(['claims.agent_id', 'agents.name', 'claims.glob', 'claims.exclusive', 'claims.expires_at'])
    .where('claims.team_id', '=', teamId)
    .where('claims.expires_at', '>', ctx.now().toISOString())
    .orderBy('claims.id')
    .execute();
  return rows.map((r) => ({
    agentId: r.agent_id, agent: r.name, glob: r.glob, exclusive: r.exclusive === 1, expiresAt: r.expires_at,
  }));
}

const toView = ({ agentId: _agentId, ...view }: ClaimView & { agentId: string }): ClaimView => view;

export async function claimFiles(ctx: HubContext, actor: Actor, input: ClaimFilesInput): Promise<ClaimResult> {
  const p = parseInput(ClaimFilesInput, input);
  const nowIso = ctx.now().toISOString();
  const expiresAt = new Date(ctx.now().getTime() + p.ttlMin * MS_PER_MIN).toISOString();
  // Check and write in one transaction so concurrent claims cannot interleave.
  return withTx(ctx, async (tx): Promise<ClaimResult> => {
    const others = (await listActiveClaims(tx, actor.teamId)).filter((c) => c.agentId !== actor.id);
    const conflicts = others.filter((c) => (p.exclusive || c.exclusive) && p.globs.some((g) => globsOverlap(g, c.glob)));
    if (conflicts.length > 0) return { granted: false, claims: [], conflicts: conflicts.map(toView) };

    await tx.db.deleteFrom('claims').where('expires_at', '<=', nowIso).execute();
    await tx.db.deleteFrom('claims').where('agent_id', '=', actor.id).where('glob', 'in', p.globs).execute();
    await tx.db.insertInto('claims').values(p.globs.map((glob) => ({
      id: tx.newId(), team_id: actor.teamId, agent_id: actor.id, glob,
      exclusive: p.exclusive ? 1 : 0, expires_at: expiresAt, created_at: nowIso,
    }))).execute();
    await logEvent(tx, actor.teamId, actor.id, 'files_claimed', { globs: p.globs, exclusive: p.exclusive, expiresAt });
    return {
      granted: true,
      claims: p.globs.map((glob) => ({ agent: actor.name, glob, exclusive: p.exclusive, expiresAt })),
      conflicts: [],
    };
  });
}

export async function releaseFiles(ctx: HubContext, actor: Actor, input: ReleaseFilesInput = {}): Promise<{ released: number }> {
  const p = parseInput(ReleaseFilesInput, input);
  const nowIso = ctx.now().toISOString();
  return withTx(ctx, async (tx) => {
    let query = tx.db.deleteFrom('claims').where('agent_id', '=', actor.id).where('expires_at', '>', nowIso);
    if (p.globs && p.globs.length > 0) query = query.where('glob', 'in', p.globs);
    const result = await query.executeTakeFirst();
    const released = Number(result.numDeletedRows);
    if (released > 0) await logEvent(tx, actor.teamId, actor.id, 'files_released', { globs: p.globs ?? 'all', count: released });
    return { released };
  });
}

export async function whoOwns(ctx: HubContext, actor: Actor, input: WhoOwnsInput): Promise<ClaimView[]> {
  const p = parseInput(WhoOwnsInput, input);
  return (await listActiveClaims(ctx, actor.teamId)).filter((c) => globMatches(c.glob, p.path)).map(toView);
}
