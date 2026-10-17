import { CreateTeamInput, MemberName, type ToolKind } from '@agentteams/shared';
import { validateNewRepoArgs, type CreateOpts } from '../commands/create.js';
import type { JoinOpts } from '../commands/join.js';
import { getAdapter } from '../tools/registry.js';
import type { ToolChoice } from './detect.js';
import type { Choice } from './prompter.js';

/**
 * Who will be on the team: decides the transport (local database, git sync, or a hub server). `newRepo` is the git
 * team on a GitHub repo created for it (offered when this directory has no remote).
 */
export type TeamKind = 'local' | 'git' | 'newRepo' | 'hub';
export type RepoChoice = 'link' | 'new' | 'local';

/** Hub invite codes: four groups of four from a lowercase alphabet without l, o, 0 and 1 (case-insensitive). */
const INVITE_RE = /^[a-km-np-z2-9]{4}(?:-[a-km-np-z2-9]{4}){3}$/i;

/** Same rule the hub applies to `create <name>`. */
export function validateTeamName(v: string): string | undefined {
  const r = CreateTeamInput.shape.name.safeParse(v);
  return r.success ? undefined : (r.error.issues[0]?.message ?? 'invalid team name');
}

/** Git-team codes: `at1-` and lowercase base32 (fully checked by the join command). */
const GIT_INVITE_RE = /^at1-[a-z2-7]{20,}$/;

export const isGitInviteCode = (v: string): boolean => GIT_INVITE_RE.test(v.trim());

export function validateInviteCode(v: string): string | undefined {
  return INVITE_RE.test(v.trim()) || isGitInviteCode(v) ? undefined : 'invite codes look like at1-... or abcd-efgh-jkmn-pqrs';
}

export function validateHubUrl(v: string): string | undefined {
  try {
    const url = new URL(v.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? undefined : 'use an http(s):// URL';
  } catch {
    return 'enter a full URL, e.g. https://hub.example.com';
  }
}

/** Detected tools first (marked), then the rest; `exclude` drops tools already linked in this repo. */
export function agentChoices(tools: ToolChoice[], exclude: readonly ToolKind[] = []): Choice<ToolKind>[] {
  return tools
    .filter((t) => !exclude.includes(t.tool))
    .map((t) => ({ value: t.tool, label: getAdapter(t.tool).label, hint: t.detected ? `detected · ${t.why}` : undefined }));
}

/**
 * `remoteUrl`: this repo's git remote (credentials stripped), or null. `newRepo`: a GitHub repo ./<name> can be
 * created with gh here (gh present, not inside a git repo, valid name).
 */
export interface TeamKindContext { remoteUrl: string | null; newRepo?: boolean; teamName?: string }

export const GIT_NO_REMOTE_HINT = 'add a git remote first (e.g. a GitHub repo)';

export function teamKindChoices(ctx: TeamKindContext = { remoteUrl: null }): Choice<TeamKind>[] {
  const git: Choice<TeamKind> = ctx.remoteUrl
    ? { value: 'git', label: "People on other computers (through this repo's git remote)", hint: ctx.remoteUrl }
    : { value: 'git', label: "People on other computers (through this repo's git remote)", hint: GIT_NO_REMOTE_HINT, disabled: true };
  return [
    { value: 'local', label: 'Just my agents on this computer' },
    git,
    ...(!ctx.remoteUrl && ctx.newRepo
      ? [{ value: 'newRepo' as const, label: `People on other computers (create a new GitHub repo ./${ctx.teamName ?? '<name>'})`, hint: 'uses gh' }]
      : []),
    { value: 'hub', label: 'A hub server (advanced)' },
  ];
}

/** A hub server answer: a full http(s) URL, or "local" for the hub `agentteams up` starts. */
export function validateHubTarget(v: string): string | undefined {
  if (v.trim().toLowerCase() === 'local') return undefined;
  return validateHubUrl(v) && 'enter a full URL (e.g. https://hub.example.com) or "local"';
}

/** `localTeam`: the team will live in a git repo's database, so "local only" needs this to be a git repo. */
export interface RepoContext { isGit: boolean; slug: string | null; hasGh: boolean; localTeam?: boolean }

/** Only the repo options that make sense here: link needs a GitHub origin, a new repo needs gh and no enclosing repo. */
export function repoChoices(ctx: RepoContext, teamName: string): Choice<RepoChoice>[] {
  const choices: Choice<RepoChoice>[] = [];
  if (ctx.slug) choices.push({ value: 'link', label: `Link this repo (${ctx.slug})` });
  if (ctx.hasGh && !ctx.isGit) {
    const bad = (() => { try { validateNewRepoArgs(teamName); return undefined; } catch (e) { return (e as Error).message; } })();
    choices.push({ value: 'new', label: `Create a new GitHub repo ./${teamName}`, hint: bad, disabled: Boolean(bad) });
  }
  if (ctx.localTeam && !ctx.isGit) return choices;
  const where = ctx.isGit ? 'this git repo, no GitHub link' : 'tied to this directory';
  choices.push({ value: 'local', label: 'Local only', hint: where });
  return choices;
}

/**
 * `hub` absent means no --hub: `kind` 'local' is a team on this computer (--this-computer), 'git' one shared
 * through the repo's remote (the default when it has one).
 */
export interface CreateAnswers {
  name: string; agent: ToolKind; repo: RepoChoice; visibility?: 'private' | 'public'; hub?: string; as?: string; kind?: TeamKind;
}

/** Menu answers → the options object `agentteams create` builds from its flags. */
export function createOptions(a: CreateAnswers): CreateOpts {
  return {
    agent: a.agent, ...(a.hub ? { hub: a.hub } : {}), install: true,
    ...(a.as ? { as: a.as } : {}),
    ...(a.kind === 'local' ? { thisComputer: true } : {}),
    ...(a.repo === 'local' ? { local: true } : {}),
    ...(a.repo === 'new' ? { newRepo: true, visibility: a.visibility ?? 'private' } : {}),
  };
}

/** `hub` absent: no --hub (an at1- code, or a code for this repo's local team). `dir`: where to clone. */
export interface JoinAnswers { code: string; agent: ToolKind; hub?: string; clone: boolean; as?: string; dir?: string }

/** Menu answers → the options object `agentteams join` builds from its flags. */
export function joinOptions(a: JoinAnswers): { code: string; opts: JoinOpts } {
  return {
    code: a.code.trim(),
    opts: { agent: a.agent, ...(a.hub ? { hub: a.hub } : {}), install: true, clone: a.clone, ...(a.as ? { as: a.as } : {}), ...(a.dir ? { dir: a.dir } : {}) },
  };
}

export function validateMemberName(v: string): string | undefined {
  return MemberName.safeParse(v).success ? undefined : 'use 1-24 characters: a-z, 0-9 or _';
}
