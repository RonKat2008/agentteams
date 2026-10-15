import { ChangesQuery, CommitInput, type CommitView } from '@agentteams/shared';
import { withTx, type Actor, type HubContext } from '../context.js';
import { parseInput } from '../errors.js';
import { logEvent } from './activity.js';
import { globMatches, listActiveClaims } from './claims.js';
import { insertMessage } from './messages.js';
import { findAgent } from './lookup.js';

const MAX_FILES_IN_NOTICE = 10;

export async function recordCommit(ctx: HubContext, actor: Actor, input: CommitInput): Promise<{ notified: string[] }> {
  const p = parseInput(CommitInput, input);
  const subject = p.message.split('\n')[0] ?? '';

  const touched = new Map<string, { name: string; files: string[] }>();
  await withTx(ctx, async (tx) => {
    for (const claim of await listActiveClaims(tx, actor.teamId)) {
      if (claim.agentId === actor.id) continue;
      const files = p.files.filter((f) => globMatches(claim.glob, f));
      if (files.length === 0) continue;
      const entry = touched.get(claim.agentId) ?? { name: claim.agent, files: [] };
      entry.files.push(...files.filter((f) => !entry.files.includes(f)));
      touched.set(claim.agentId, entry);
    }
    await tx.db.insertInto('commits').values({
      id: tx.newId(), team_id: actor.teamId, agent_id: actor.id, sha: p.sha, branch: p.branch,
      message: p.message, files_json: JSON.stringify(p.files), insertions: p.insertions, deletions: p.deletions,
      created_at: tx.now().toISOString(),
    }).execute();
    await logEvent(tx, actor.teamId, actor.id, 'commit', {
      sha: p.sha, branch: p.branch, subject, files: p.files.length, insertions: p.insertions, deletions: p.deletions,
    });
    for (const [agentId, { files }] of touched) {
      const shown = files.slice(0, MAX_FILES_IN_NOTICE).join(', ');
      const more = files.length > MAX_FILES_IN_NOTICE ? ` and ${files.length - MAX_FILES_IN_NOTICE} more` : '';
      await insertMessage(tx, {
        teamId: actor.teamId, fromId: actor.id, toId: agentId, kind: 'fyi',
        body: `${actor.name} committed ${p.sha.slice(0, 7)} on ${p.branch} touching files you claimed: ${shown}${more} — "${subject}"`,
      });
    }
  });

  return { notified: [...touched.values()].map((t) => t.name) };
}

export async function getChanges(ctx: HubContext, actor: Actor, input: ChangesQuery = {}): Promise<CommitView[]> {
  const p = parseInput(ChangesQuery, input);
  let query = ctx.db.selectFrom('commits')
    .innerJoin('agents', 'agents.id', 'commits.agent_id')
    .select(['commits.sha', 'commits.branch', 'agents.name', 'commits.message', 'commits.files_json',
      'commits.insertions', 'commits.deletions', 'commits.created_at'])
    .where('commits.team_id', '=', actor.teamId);
  if (p.agent) query = query.where('commits.agent_id', '=', (await findAgent(ctx, actor.teamId, p.agent)).id);
  if (p.since) query = query.where('commits.created_at', '>', new Date(p.since).toISOString());
  const rows = await query.orderBy('commits.id', 'desc').limit(p.limit).execute();
  return rows.map((r) => ({
    sha: r.sha, branch: r.branch, agent: r.name, message: r.message,
    files: JSON.parse(r.files_json) as string[], insertions: r.insertions, deletions: r.deletions, createdAt: r.created_at,
  }));
}
