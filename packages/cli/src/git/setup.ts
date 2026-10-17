/**
 * Creating and joining git teams (`agentteams create` in a repo with a remote, `agentteams join at1-...`).
 *
 * create: new team id, team key and agent key -> createTeam bootstrap (writes, signs, encrypts and pins the team
 *         meta) -> one sync round (pushes meta and log). A failed push undoes everything local.
 * join:   fetch the team refs -> decrypt and verify the meta for the invite's team id -> pin it -> one round to
 *         ingest the members -> free name -> join bootstrap -> one round (push). A failed push undoes the join.
 *
 * The credential is saved by the caller only after the push succeeded. Keys are never printed except inside the
 * invite code.
 */
import { rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoLink, ToolKind } from '@agentteams/shared';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { hasLocalTeam } from '../local/team.js';
import { openTeamStore } from '../local/store.js';
import { newAgentKeyPair, newTeamKey } from './crypto.js';
import { createHlc } from './hlc.js';
import { encodeInvite } from './invite.js';
import { decodeMeta, MAX_META_BYTES, metaPin } from './meta.js';
import { captureBootstrapOp, mintOpId } from './ops.js';
import { fetchTeam, readFetchedMeta } from './refs.js';
import { pinTeamMeta, REPLICATED_TABLES, rebuildView, type TeamCreator } from './replay.js';
import { remoteFetchUrl, shareableUrl } from './remoteUrl.js';
import { syncRound, writeBootstrap, type SyncSummary } from './sync.js';
import { acquireLock } from './syncState.js';
import { freeAgentName, openGitView, replayTarget, seededHlc, teamCreatorOf } from './view.js';

type Deps = Pick<CliDeps, 'exec'>;

/** Team ids appear in ref names: refs.ts accepts `[0-9A-Za-z]{10,40}` (stricter than the invite format). */
const TEAM_ID_RE = /^[0-9A-Za-z]{10,40}$/;
const LOCK_WAIT_MS = 30_000;

export const INVITE_WARNING =
  'Treat this code like a password: it lets someone read and join the team, together with access to the repo.';

/** What a repo's team database already holds: nothing, or the id and name of its (one) team. */
async function teamInRepo(deps: Deps, repo: string): Promise<{ id: string; name: string } | null> {
  if (!(await hasLocalTeam(deps, repo))) return null;
  const { ctx } = await openTeamStore(deps, repo);
  return (await ctx.db.selectFrom('teams').select(['id', 'name']).limit(1).executeTakeFirst()) ?? null;
}

/** True when this repo's database holds a git team (its meta is pinned). Never creates the database. */
export async function hasGitTeam(deps: Deps, repo: string): Promise<boolean> {
  if (!(await hasLocalTeam(deps, repo))) return false;
  const { ctx } = await openTeamStore(deps, repo);
  return (await ctx.db.selectFrom('team_meta_pins').select('team_id').limit(1).executeTakeFirst()) !== undefined;
}

/** The URL an invite carries for a credential's remote (a remote name of the clone, or a URL). */
export async function inviteUrlOf(deps: Deps, repo: string, remote: string): Promise<string> {
  return shareableUrl((await remoteFetchUrl(deps, repo, remote)) ?? remote, repo);
}

/** The invite code for a git credential (from the stored team key and the pinned creator). */
export async function inviteCodeOf(deps: Deps, cred: Credential): Promise<{ code: string; url: string }> {
  const g = cred.git!;
  const url = await inviteUrlOf(deps, cred.repoPath, g.remote);
  const creator = await teamCreatorOf(await openGitView(deps, cred));
  if (!creator) throw new Error('this clone has not verified the team yet; run "agentteams sync" first');
  return { code: encodeInvite({ remote: url, teamId: g.teamId, key: g.teamKey, creator }), url };
}

/** Credentials embedded in a URL (`//user:pass@`) never reach a message. */
const redact = (text: string): string => text.replace(/\/\/[^@/\s]+@/g, '//');
const firstError = (s: SyncSummary): string => redact(s.errors[0] ?? 'nothing was pushed');

function pushFailure(url: string, s: SyncSummary): Error {
  return new Error(`could not push the team to ${url}: push access to ${url} is required (${firstError(s)})`);
}

// ---- Rollback ----------------------------------------------------------------------------------------

async function deleteRefs(deps: Deps, repo: string, prefixes: string[]): Promise<void> {
  const r = await deps.exec('git', ['for-each-ref', '--format=%(refname)', ...prefixes], { cwd: repo });
  const refs = r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  if (refs.length === 0) return;
  await deps.exec('git', ['update-ref', '--stdin'], { cwd: repo, input: refs.map((ref) => `delete ${ref}\n`).join('') });
}

/**
 * Undoes a create whose push failed: every local trace of the team (refs, replica files, view rows, pins). The
 * repo held no team before the create (checked up front), so the view tables are emptied.
 */
async function discardCreatedTeam(deps: Deps, repo: string, cred: Credential): Promise<void> {
  const { teamId, agentId } = cred.git!;
  const view = await openGitView(deps, cred);
  const lock = await acquireLock(view.paths.lock, { waitMs: LOCK_WAIT_MS });
  try {
    await deleteRefs(deps, repo, ['agentteams-local', 'agentteams-remote', 'agentteams-seen'].map((p) => `refs/${p}/${teamId}/`));
    await rm(view.files.dir, { recursive: true, force: true });
    const db = view.store.ctx.db;
    await db.transaction().execute(async (trx) => {
      for (const table of REPLICATED_TABLES) await trx.deleteFrom(table).execute();
      await trx.deleteFrom('team_meta_pins').where('team_id', '=', teamId).execute();
      await trx.deleteFrom('agent_key_pins').where('agent_id', '=', agentId).execute();
      await trx.deleteFrom('replica_pending').where('agent_id', '=', agentId).execute();
      await trx.deleteFrom('replica_notices').where('agent_id', '=', agentId).execute();
    });
  } finally {
    await lock?.release();
  }
}

/** Undoes a join whose push failed: the agent's log, its accepted segments and pin, then rebuilds the view. */
async function discardJoinedAgent(deps: Deps, repo: string, cred: Credential): Promise<void> {
  const { teamId, agentId } = cred.git!;
  const view = await openGitView(deps, cred);
  const lock = await acquireLock(view.paths.lock, { waitMs: LOCK_WAIT_MS });
  try {
    await deleteRefs(deps, repo, ['agentteams-local', 'agentteams-remote', 'agentteams-seen'].map((p) => `refs/${p}/${teamId}/agents/${agentId}`));
    await unlink(join(view.files.dir, 'accepted', `${agentId}.jsonl`)).catch(() => undefined);
    const db = view.store.ctx.db;
    await db.deleteFrom('agent_key_pins').where('agent_id', '=', agentId).execute();
    await db.deleteFrom('replica_pending').where('agent_id', '=', agentId).execute();
    await db.deleteFrom('replica_notices').where('agent_id', '=', agentId).execute();
    const creator = await teamCreatorOf(view);
    if (creator) {
      const { store, source } = replayTarget(view);
      await rebuildView(store, { source, teamCreator: creator, teamId, nowMs: Date.now() });
    }
  } finally {
    await lock?.release();
  }
}

// ---- Create ------------------------------------------------------------------------------------------

export interface GitCreateInput {
  repoPath: string;
  /** The remote name the team is shared through (`origin`, or `--remote`). */
  remote: string;
  name: string;
  tool: ToolKind;
  member: string;
  repo: RepoLink;
}

export interface GitSetupResult { cred: Credential; inviteCode: string; remoteUrl: string; summary: SyncSummary }

export async function createGitTeam(deps: Deps, input: GitCreateInput): Promise<GitSetupResult> {
  const { repoPath, remote, tool, member } = input;
  const url = await inviteUrlOf(deps, repoPath, remote);
  const existing = await teamInRepo(deps, repoPath);
  if (existing) {
    throw new Error(`this repo already has a team ("${existing.name}"); a repo holds one team (use another clone for another team)`);
  }
  const hlc = createHlc();
  const teamId = mintOpId(hlc.tick());
  const teamKey = newTeamKey();
  const keys = newAgentKeyPair();
  const agentName = `${member}-${tool}`;
  const { agentId, op } = captureBootstrapOp(hlc, 'createTeam', {
    teamId, name: input.name, repo: input.repo, member, tool, agentName, publicKey: keys.publicKey,
  });
  const cred: Credential = {
    repoPath, tool, hubUrl: '', teamName: input.name, agentName, apiKey: '', createdAt: new Date().toISOString(),
    transport: 'git', git: { teamId, agentId, remote, teamKey, ...keys },
  };
  let summary: SyncSummary;
  try {
    await writeBootstrap(deps, repoPath, cred, op, { waitMs: LOCK_WAIT_MS });
    summary = await syncRound(deps, repoPath, cred, { waitMs: LOCK_WAIT_MS });
  } catch (err) {
    await discardCreatedTeam(deps, repoPath, cred).catch(() => undefined);
    throw err;
  }
  if (!summary.ok || !summary.pushed) {
    await discardCreatedTeam(deps, repoPath, cred).catch(() => undefined);
    throw pushFailure(url, summary);
  }
  const creator = { agentId, publicKey: keys.publicKey };
  return { cred, inviteCode: encodeInvite({ remote: url, teamId, key: teamKey, creator }), remoteUrl: url, summary };
}

// ---- Join --------------------------------------------------------------------------------------------

export interface GitJoinInput {
  repoPath: string;
  /** A remote name of the clone, or the invite's URL (with --no-clone in an unrelated repo). */
  remote: string;
  /** The invite's URL, for messages. */
  url: string;
  teamId: string;
  teamKey: string;
  /** The team's creator as the invite names it: pinned before anything is fetched. */
  creator: TeamCreator;
  tool: ToolKind;
  member: string;
}

const MISMATCH = (url: string) =>
  `the team data shared through ${url} does not match this invite code (its creator differs); refusing to join. ` +
  'Ask the team creator for a fresh invite (agentteams invite show) and check the repo has not been tampered with';

/** Fetches the team, verifies its meta against the invite, pins it and ingests the members (one round). */
async function fetchAndVerify(deps: Deps, input: GitJoinInput, probe: Credential): Promise<{ teamName: string }> {
  const { repoPath, remote, url, teamId, teamKey, creator } = input;
  const view = await openGitView(deps, probe);
  // Trust comes from the invite, not from the meta ref on first sight.
  if ((await pinTeamMeta(view.store, teamId, { agentId: creator.agentId, publicKey: creator.publicKey })) === 'mismatch') {
    throw new Error(`this clone already trusts a different creator for team ${teamId}; ${MISMATCH(url)}`);
  }
  const f = await fetchTeam(deps, repoPath, remote, teamId);
  if (!f.ok) throw new Error(`could not fetch the team from ${url}: ${redact((f.error ?? 'git failed').split('\n')[0]!)} (do you have access to the repo?)`);
  const buf = await readFetchedMeta(deps, repoPath, teamId, MAX_META_BYTES);
  if (!buf) throw new Error(`${url} has no agentteams team ${teamId} (was the invite made for this repo, and was the team pushed?)`);
  const meta = decodeMeta(buf, teamKey, teamId);
  if (!meta) throw new Error(`the team on ${url} does not match this invite code (wrong key, or the team data was altered)`);
  if (meta.agentId !== creator.agentId || meta.publicKey !== creator.publicKey) throw new Error(MISMATCH(url));
  await pinTeamMeta(view.store, teamId, metaPin(meta));
  const round = await syncRound(deps, repoPath, probe, { waitMs: LOCK_WAIT_MS });
  if (!round.fetched) throw new Error(`could not sync with ${url}: ${firstError(round)}`);
  const team = await view.store.ctx.db.selectFrom('teams').select('name').where('id', '=', teamId).executeTakeFirst();
  if (!team) throw new Error(`the team's history on ${url} could not be read yet (${round.problems[0] ?? 'the creator\'s log is missing'})`);
  return { teamName: team.name };
}

export async function joinGitTeam(deps: Deps, input: GitJoinInput): Promise<GitSetupResult & { teamName: string }> {
  const { repoPath, remote, url, teamId, teamKey, creator, tool, member } = input;
  if (!TEAM_ID_RE.test(teamId)) throw new Error('this invite code names an unsupported team id');
  const existing = await teamInRepo(deps, repoPath);
  if (existing && existing.id !== teamId) {
    throw new Error(`this repo already has another team ("${existing.name}"); a repo holds one team (clone the repo elsewhere with --dir)`);
  }
  const keys = newAgentKeyPair();
  // The agent id is the join op's id, which needs the free name first: the pre-join round runs as a probe identity
  // that never writes a log (a round only writes presence and pushes for an agent with a local log).
  const probe: Credential = {
    repoPath, tool, hubUrl: '', teamName: '', agentName: '', apiKey: '', createdAt: new Date().toISOString(),
    transport: 'git', git: { teamId, agentId: mintOpId(createHlc().tick()), remote, teamKey, ...keys },
  };
  const { teamName } = await fetchAndVerify(deps, input, probe);
  const view = await openGitView(deps, probe);
  const agentName = await freeAgentName(view.store, teamId, `${member}-${tool}`);
  const { agentId, op } = captureBootstrapOp(await seededHlc(view), 'join', { teamId, member, tool, agentName, publicKey: keys.publicKey });
  const cred: Credential = { ...probe, teamName, agentName, git: { ...probe.git!, agentId } };
  let summary: SyncSummary;
  try {
    await writeBootstrap(deps, repoPath, cred, op, { waitMs: LOCK_WAIT_MS });
    summary = await syncRound(deps, repoPath, cred, { waitMs: LOCK_WAIT_MS });
  } catch (err) {
    await discardJoinedAgent(deps, repoPath, cred).catch(() => undefined);
    throw err;
  }
  if (!summary.ok || !summary.pushed) {
    await discardJoinedAgent(deps, repoPath, cred).catch(() => undefined);
    throw pushFailure(url, summary);
  }
  return { cred, teamName, inviteCode: encodeInvite({ remote: url, teamId, key: teamKey, creator }), remoteUrl: url, summary };
}
