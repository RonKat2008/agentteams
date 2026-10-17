import { type ToolKind } from '@agentteams/shared';
import { createCommand, HUB_INVITE_WARNING, teammateJoinCommand, validateNewRepoArgs, type CreateOpts, type CreateResult } from '../commands/create.js';
import { joinCommand, type JoinOpts } from '../commands/join.js';
import { logCommand, type LogOpts } from '../commands/log.js';
import { dateOnly } from '../commands/shared.js';
import { statusCommand } from '../commands/status.js';
import type { UpOptions } from '../commands/up.js';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { mkdir } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { decodeInvite } from '../git/invite.js';
import { findRemoteFor, pickRemote, remoteFetchUrl, remoteNames, repoNameOf, stripCredentials } from '../git/remoteUrl.js';
import { INVITE_WARNING, inviteCodeOf } from '../git/setup.js';
import { hubUrlFrom } from '../paths.js';
import { detectGithubSlug, isGitRepo, real, repoRoot, resolveMemberName } from '../repo.js';
import {
  agentChoices, createOptions, defaultTeamKind, isGitInviteCode, joinOptions, repoChoices, teamKindChoices,
  validateHubTarget, validateInviteCode, validateMemberName, validateTeamName, type RepoChoice, type TeamKind,
} from './choices.js';
import type { ToolChoice } from './detect.js';
import type { Choice, Prompter } from './prompter.js';

/** The command functions the menu drives: the same ones the subcommands call. Tests inject fakes. */
export interface TuiCommands {
  create: (deps: CliDeps, name: string, opts: CreateOpts) => Promise<CreateResult>;
  join: (deps: CliDeps, code: string, opts: JoinOpts) => Promise<void>;
  status: (deps: CliDeps, opts: { agent?: ToolKind }) => Promise<void>;
  log: (deps: CliDeps, opts: LogOpts) => Promise<void>;
  up: (deps: CliDeps, opts: UpOptions) => Promise<void>;
}

export const realCommands: TuiCommands = {
  create: createCommand,
  join: joinCommand,
  status: statusCommand,
  log: logCommand,
  // The hub (hono, sqlite, pg) loads only when a hub is actually started.
  up: async (deps, opts) => (await import('../commands/up.js')).upCommand(deps, opts),
};

export interface TuiContext {
  deps: CliDeps;
  p: Prompter;
  commands: TuiCommands;
  tools: ToolChoice[];
  hasGh: boolean;
  /** Credentials for the repo in the current directory (empty when it has no team yet). */
  linked: Credential[];
  /** This repo already has a local team database (join and link use it without asking about hubs). */
  localTeam: boolean;
}

const LOG_LIMIT = 20;

async function pickAgent(ctx: TuiContext, message: string, exclude: readonly ToolKind[] = []): Promise<ToolKind | null> {
  const choices = agentChoices(ctx.tools, exclude);
  if (choices.length === 0) return null;
  const firstDetected = ctx.tools.find((t) => t.detected && !exclude.includes(t.tool))?.tool;
  return ctx.p.select(message, choices, firstDetected ?? choices[0]!.value);
}

const HEALTH_TIMEOUT_MS = 2000;

/** Local-mode hubs have no GitHub sign-in, so members name themselves; hosted hubs use the gh login. */
async function isLocalModeHub(deps: CliDeps, hub: string): Promise<boolean> {
  try {
    const res = await deps.fetch(`${hubUrlFrom(hub, deps.env)}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return ((await res.json()) as { mode?: unknown }).mode === 'local';
  } catch {
    return false;
  }
}

async function memberName(ctx: TuiContext): Promise<string> {
  const as = await ctx.p.text('Your name on this team', { initial: await resolveMemberName(ctx.deps, ctx.deps.cwd), validate: validateMemberName });
  return as.toLowerCase();
}

/** The advanced path: a hub server by URL (or "local" for `agentteams up`); local-mode hubs need a member name. */
async function pickHubServer(ctx: TuiContext): Promise<{ hub: string; as?: string }> {
  const raw = await ctx.p.text('Hub URL, or "local" for a hub started on this machine', {
    placeholder: 'https://hub.example.com', validate: validateHubTarget,
  });
  const hub = raw.trim().toLowerCase() === 'local' ? 'local' : raw.trim();
  if (!(await isLocalModeHub(ctx.deps, hub))) return { hub };
  return { hub, as: await memberName(ctx) };
}

interface RemoteHere { url: string | null; several: Choice<string>[] }

/**
 * This repo's git remote for a new team (credentials stripped), or, when there are several and none is origin,
 * every remote to pick from.
 */
async function remoteHere(deps: CliDeps): Promise<RemoteHere> {
  const names = await remoteNames(deps, deps.cwd);
  const urlOf = async (name: string) => {
    const url = await remoteFetchUrl(deps, deps.cwd, name);
    return url ? stripCredentials(url) : null;
  };
  try {
    const name = await pickRemote(deps, deps.cwd);
    return { url: name ? await urlOf(name) : null, several: [] };
  } catch {
    const several = await Promise.all(names.map(async (n) => ({ value: n, label: n, hint: (await urlOf(n)) ?? undefined })));
    return { url: null, several };
  }
}

const canCreateRepo = (name: string): boolean => {
  try { validateNewRepoArgs(name); return true; } catch { return false; }
};

/** Which repo a local or hub team is for (a git team is for this repo, or the new GitHub repo). */
async function pickRepo(ctx: TuiContext, name: string, kind: TeamKind, isGit: boolean): Promise<RepoChoice> {
  const repoCtx = { isGit, slug: await detectGithubSlug(ctx.deps, ctx.deps.cwd), hasGh: ctx.hasGh, localTeam: kind === 'local' };
  // A new GitHub repo is for sharing the team, so it is offered as its own "who" answer, not for a local team.
  const choices = repoChoices(repoCtx, name).filter((c) => kind !== 'local' || c.value !== 'new');
  if (choices.length === 0) throw new Error('a team for agents on this computer lives in a git repository; run "git init" here first');
  return ctx.p.select('Which repo is this team for?', choices);
}

/**
 * A team for this computer lives in a git repo. Outside one, offer a new project folder ./<name> (the default) or
 * this folder, then `git init` it. Never the home folder or the filesystem root. Returns deps rooted there.
 */
async function projectFolder(ctx: TuiContext, name: string): Promise<CliDeps> {
  const { deps, p } = ctx;
  const cwd = await real(deps.cwd);
  const unsafe = cwd === (await real(deps.homedir)) ? 'this is your home folder' : cwd === parse(cwd).root ? 'the filesystem root' : undefined;
  const folder = join(deps.cwd, name);
  const where = await p.select<'folder' | 'here'>('Where should the team live?', [
    { value: 'folder', label: `A new project folder ./${name}`, hint: folder },
    { value: 'here', label: 'This folder (runs git init here)', hint: unsafe ?? cwd, disabled: Boolean(unsafe) },
  ], 'folder');
  const dir = where === 'folder' ? folder : deps.cwd;
  if (where === 'folder') await mkdir(dir, { recursive: true });
  const init = await deps.exec('git', ['init', '-b', 'main'], { cwd: dir });
  if (init.code !== 0) throw new Error(`git init failed in ${dir}: ${(init.stderr || init.stdout).trim()}`);
  p.info(where === 'folder' ? `Made ./${name} a git repo. Start your agents there: cd ${name}` : 'Made this folder a git repo.');
  return { ...deps, cwd: dir };
}

const pickVisibility = (p: Prompter) => p.select<'private' | 'public'>('New repo visibility', [
  { value: 'private', label: 'Private' }, { value: 'public', label: 'Public' }], 'private');

function createdBox(p: Prompter, res: CreateResult): void {
  if (res.remoteUrl) {
    p.box([
      `Shared through ${res.remoteUrl}`,
      '',
      'Send teammates this command (they also need access to the repo):',
      `  ${teammateJoinCommand(res.inviteCode, '')}`,
      '',
      INVITE_WARNING,
    ].join('\n'), ` Team "${res.teamName}" is ready `);
    return;
  }
  p.box([
    `Invite code: ${res.inviteCode}   (expires ${dateOnly(res.inviteExpiresAt)})`,
    '',
    res.hubUrl ? 'Send teammates this command:' : 'Add another agent on this computer (run it in the team repo):',
    `  ${teammateJoinCommand(res.inviteCode, res.hubUrl)}`,
    '',
    HUB_INVITE_WARNING,
    'Run "agentteams invite" to see it again.',
  ].join('\n'), ` Team "${res.teamName}" is ready `);
}

export async function createFlow(ctx: TuiContext): Promise<void> {
  const { p } = ctx;
  let { deps } = ctx;
  const name = await p.text('Team name', { placeholder: 'my-team', validate: validateTeamName });
  const agent = (await pickAgent(ctx, 'Which agent do you want to link?'))!;
  const isGit = await isGitRepo(deps, deps.cwd);
  const here = isGit ? await remoteHere(deps) : { url: null, several: [] };
  const kindCtx = { remoteUrl: here.url, severalRemotes: here.several.length > 0, newRepo: ctx.hasGh && !isGit && canCreateRepo(name), teamName: name };
  const kind = await p.select<TeamKind>('Who will be on this team?', teamKindChoices(kindCtx), defaultTeamKind(kindCtx));
  const remote = kind === 'git' && here.several.length > 0
    ? await p.select('Which git remote should the team be shared through?', here.several)
    : undefined;
  const madeRepo = kind === 'local' && !isGit;
  if (madeRepo) deps = await projectFolder(ctx, name);
  // A git team is for this repo (its remote), or for the GitHub repo created for it.
  const repo: RepoChoice = kind === 'git' ? 'link' : kind === 'newRepo' ? 'new' : madeRepo ? 'local' : await pickRepo(ctx, name, kind, isGit);
  const visibility = repo === 'new' ? await pickVisibility(p) : undefined;
  const { hub, as } = kind === 'hub' ? await pickHubServer(ctx) : { hub: undefined, as: await memberName(ctx) };
  // Without a hub the choice is explicit even when AGENTTEAMS_HUB is set in the environment.
  const createDeps = hub ? deps : { ...deps, env: { ...deps.env, AGENTTEAMS_HUB: '' } };
  const opts = createOptions({ name, agent, repo, visibility, hub, as, kind, remote });
  createdBox(p, await ctx.commands.create(createDeps, name, opts));
}

/** Where an at1- team's repo should live: no question when this directory already is a clone of it. */
async function pickCloneTarget(ctx: TuiContext, code: string): Promise<{ clone: boolean; dir?: string }> {
  const { deps, p } = ctx;
  let url: string;
  try { url = decodeInvite(code.trim().toLowerCase()).remote; } catch (e) { throw new Error(`invalid invite code: ${(e as Error).message}`); }
  const isGit = await isGitRepo(deps, deps.cwd);
  if (isGit && (await findRemoteFor(deps, await repoRoot(deps, deps.cwd), url))) return { clone: false };
  const name = repoNameOf(url) ?? 'team-repo';
  const where = await p.select<'here' | 'dir' | 'cwd'>(`Where should the team repo (${url}) be cloned?`, [
    { value: 'here', label: `Clone it into ./${name}` },
    { value: 'dir', label: 'Clone it into another folder' },
    ...(isGit ? [{ value: 'cwd' as const, label: 'Use the current directory', hint: 'no clone' }] : []),
  ], 'here');
  if (where === 'cwd') return { clone: false };
  if (where === 'here') return { clone: true };
  const dir = await p.text('Folder to clone into', { placeholder: `../${name}`, validate: (v) => (v.trim() ? undefined : 'enter a folder') });
  return { clone: true, dir };
}

export async function joinFlow(ctx: TuiContext): Promise<void> {
  const { deps, p } = ctx;
  const code = await p.text('Invite code', { placeholder: 'at1-... or abcd-efgh-jkmn-pqrs', validate: validateInviteCode });
  const agent = (await pickAgent(ctx, 'Which agent do you want to link?'))!;
  if (isGitInviteCode(code)) {
    // A team shared through git: no hub; clone the repo unless this directory is a clone of it.
    const target = await pickCloneTarget(ctx, code);
    const args = joinOptions({ code, agent, as: await memberName(ctx), ...target });
    await ctx.commands.join(deps, args.code, args.opts);
    p.success('Joined. Open your agent in the repo to start working with the team.');
    return;
  }
  if (ctx.localTeam) {
    // This repo holds a local team: the code is for it, so no hub and nothing to clone.
    const args = joinOptions({ code, agent, as: await memberName(ctx), clone: false });
    await ctx.commands.join(deps, args.code, args.opts);
    p.success('Joined. Open your agent in the repo to start working with the team.');
    return;
  }
  const { hub, as } = await pickHubServer(ctx);
  const where = await p.select<'clone' | 'here'>('Where should the team repo live?', [
    { value: 'clone', label: 'Clone it here', hint: 'skipped when this directory already is the team repo' },
    { value: 'here', label: 'Use the current directory' },
  ], 'clone');
  const args = joinOptions({ code, agent, hub, as, clone: where === 'clone' });
  await ctx.commands.join(deps, args.code, args.opts);
  p.success('Joined. Open your agent in the repo to start working with the team.');
}

/**
 * A second agent in the same repo joins the same team through `join` with an invite code, on the hub the
 * existing credential uses (or the repo's local database). Invite codes are stored hashed, so the code has to
 * come from the user.
 */
export async function linkFlow(ctx: TuiContext): Promise<void> {
  const { deps, p } = ctx;
  const cred = ctx.linked[0]!;
  const agent = await pickAgent(ctx, 'Which agent do you want to add?', ctx.linked.map((c) => c.tool));
  if (!agent) { p.info('Every agent is already linked to this team.'); return; }
  // Same person, another tool: agent names are <member>-<tool>. Hosted hubs ignore this and use the gh login.
  const member = cred.agentName.endsWith(`-${cred.tool}`) ? cred.agentName.slice(0, -cred.tool.length - 1) : undefined;
  if (cred.transport === 'git') {
    // A git team's code is derived from the stored team key: nothing to paste.
    const args = joinOptions({ code: (await inviteCodeOf(deps, cred)).code, agent, as: member, clone: false });
    await ctx.commands.join(deps, args.code, args.opts);
    p.success(`${agent} is linked to "${cred.teamName}".`);
    return;
  }
  const stored = cred.invite && Date.parse(cred.invite.expiresAt) > Date.now() ? cred.invite.code : undefined;
  p.info(stored
    ? `Using the invite code stored for "${cred.teamName}" (change it to paste another).`
    : `Paste the invite code for "${cred.teamName}" ("agentteams invite --rotate" issues a new one).`);
  const code = await p.text('Invite code', { placeholder: 'abcd-efgh-jkmn-pqrs', initial: stored, validate: validateInviteCode });
  const hub = cred.transport === 'local' ? undefined : cred.hubUrl;
  const args = joinOptions({ code, agent, hub, as: member, clone: false });
  await ctx.commands.join(deps, args.code, args.opts);
  p.success(`${agent} is linked to "${cred.teamName}".`);
}

/** With several agents linked in this repo, status and log need to know whose credential to use. */
async function pickLinked(ctx: TuiContext): Promise<ToolKind | undefined> {
  if (ctx.linked.length < 2) return undefined;
  return ctx.p.select('As which agent?', ctx.linked.map((c) => ({ value: c.tool, label: c.tool, hint: c.agentName })));
}

export async function statusFlow(ctx: TuiContext): Promise<void> {
  await ctx.commands.status(ctx.deps, { agent: await pickLinked(ctx) });
}

export async function logFlow(ctx: TuiContext): Promise<void> {
  await ctx.commands.log(ctx.deps, { agent: await pickLinked(ctx), follow: false, limit: LOG_LIMIT });
}

export async function upFlow(ctx: TuiContext): Promise<void> {
  const share = await ctx.p.select<'local' | 'share'>('How should teammates reach the hub?', [
    { value: 'local', label: 'This machine only', hint: 'use --hub local' },
    { value: 'share', label: 'Share over the internet', hint: 'Cloudflare quick tunnel (up --share)' },
  ], 'local');
  await ctx.commands.up(ctx.deps, { share: share === 'share' });
}
