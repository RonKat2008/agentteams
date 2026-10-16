import { defaultMemberName, type ToolKind } from '@agentteams/shared';
import { createCommand, teammateJoinCommand, type CreateOpts, type CreateResult } from '../commands/create.js';
import { joinCommand, type JoinOpts } from '../commands/join.js';
import { logCommand, type LogOpts } from '../commands/log.js';
import { dateOnly } from '../commands/shared.js';
import { statusCommand } from '../commands/status.js';
import type { UpOptions } from '../commands/up.js';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { hubUrlFrom } from '../paths.js';
import { detectGithubSlug, isGitRepo } from '../repo.js';
import {
  agentChoices, createOptions, hubChoices, hubFlag, joinOptions, repoChoices,
  validateHubUrl, validateInviteCode, validateMemberName, validateTeamName, type HubChoice,
} from './choices.js';
import type { ToolChoice } from './detect.js';
import type { Prompter } from './prompter.js';

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

async function pickHub(ctx: TuiContext): Promise<{ hub: string; as?: string }> {
  const { deps, p } = ctx;
  const choice = await p.select<HubChoice>('Which hub should the team use?', hubChoices(), 'public');
  const url = choice === 'custom' ? await p.text('Hub URL', { placeholder: 'https://hub.example.com', validate: validateHubUrl }) : undefined;
  const hub = hubFlag(choice, url);
  if (choice === 'public' || !(await isLocalModeHub(deps, hub))) return { hub };
  const as = await p.text('Your name on this team', { initial: defaultMemberName(deps.username), validate: validateMemberName });
  return { hub, as: as.toLowerCase() };
}

export async function createFlow(ctx: TuiContext): Promise<void> {
  const { deps, p } = ctx;
  const name = await p.text('Team name', { placeholder: 'my-team', validate: validateTeamName });
  const agent = (await pickAgent(ctx, 'Which agent do you want to link?'))!;
  const repoCtx = { isGit: await isGitRepo(deps, deps.cwd), slug: await detectGithubSlug(deps, deps.cwd), hasGh: ctx.hasGh };
  const repo = await p.select('Which repo is this team for?', repoChoices(repoCtx, name));
  const visibility = repo === 'new'
    ? await p.select<'private' | 'public'>('New repo visibility', [
      { value: 'private', label: 'Private' }, { value: 'public', label: 'Public' }], 'private')
    : undefined;
  const { hub, as } = await pickHub(ctx);
  const res = await ctx.commands.create(deps, name, createOptions({ name, agent, repo, visibility, hub, as }));
  p.box([
    `Invite code: ${res.inviteCode}   (expires ${dateOnly(res.inviteExpiresAt)})`,
    '',
    'Send teammates this command:',
    `  ${teammateJoinCommand(res.inviteCode, res.hubUrl)}`,
  ].join('\n'), ` Team "${res.teamName}" is ready `);
}

export async function joinFlow(ctx: TuiContext): Promise<void> {
  const { deps, p } = ctx;
  const code = await p.text('Invite code', { placeholder: 'abcd-efgh-jkmn-pqrs', validate: validateInviteCode });
  const agent = (await pickAgent(ctx, 'Which agent do you want to link?'))!;
  const { hub, as } = await pickHub(ctx);
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
 * existing credential uses. The hub stores invite codes hashed, so the code has to come from the user.
 */
export async function linkFlow(ctx: TuiContext): Promise<void> {
  const { deps, p } = ctx;
  const cred = ctx.linked[0]!;
  const agent = await pickAgent(ctx, 'Which agent do you want to add?', ctx.linked.map((c) => c.tool));
  if (!agent) { p.info('Every agent is already linked to this team.'); return; }
  p.info(`Paste the invite code for "${cred.teamName}" (printed by create; "agentteams invite rotate" issues a new one).`);
  const code = await p.text('Invite code', { placeholder: 'abcd-efgh-jkmn-pqrs', validate: validateInviteCode });
  // Same person, another tool: agent names are <member>-<tool>. Hosted hubs ignore this and use the gh login.
  const member = cred.agentName.endsWith(`-${cred.tool}`) ? cred.agentName.slice(0, -cred.tool.length - 1) : undefined;
  const args = joinOptions({ code, agent, hub: cred.hubUrl, as: member, clone: false });
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
