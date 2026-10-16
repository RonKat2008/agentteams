import { CreateTeamInput, MemberName, type ToolKind } from '@agentteams/shared';
import { validateNewRepoArgs, type CreateOpts } from '../commands/create.js';
import type { JoinOpts } from '../commands/join.js';
import { DEFAULT_HUB_URL, LOCAL_HUB_URL } from '../paths.js';
import { getAdapter } from '../tools/registry.js';
import type { ToolChoice } from './detect.js';
import type { Choice } from './prompter.js';

export type HubChoice = 'public' | 'local' | 'custom';
export type RepoChoice = 'link' | 'new' | 'local';

/** Hub invite codes: four groups of four from a lowercase alphabet without l, o, 0 and 1 (case-insensitive). */
const INVITE_RE = /^[a-km-np-z2-9]{4}(?:-[a-km-np-z2-9]{4}){3}$/i;

/** Same rule the hub applies to `create <name>`. */
export function validateTeamName(v: string): string | undefined {
  const r = CreateTeamInput.shape.name.safeParse(v);
  return r.success ? undefined : (r.error.issues[0]?.message ?? 'invalid team name');
}

export function validateInviteCode(v: string): string | undefined {
  return INVITE_RE.test(v.trim()) ? undefined : 'invite codes look like abcd-efgh-jkmn-pqrs';
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

export const hubChoices = (): Choice<HubChoice>[] => [
  { value: 'public', label: 'Public hub', hint: DEFAULT_HUB_URL },
  { value: 'local', label: 'Local hub on this machine', hint: `${LOCAL_HUB_URL}, start it with "Start a local hub"` },
  { value: 'custom', label: 'Custom hub URL' },
];

/** The --hub value for a hub choice (custom URLs were validated by the prompt). */
export function hubFlag(choice: HubChoice, customUrl?: string): string {
  if (choice === 'public') return DEFAULT_HUB_URL;
  if (choice === 'local') return 'local';
  return (customUrl ?? '').trim();
}

export interface RepoContext { isGit: boolean; slug: string | null; hasGh: boolean }

/** Only the repo options that make sense here: link needs a GitHub origin, a new repo needs gh and no enclosing repo. */
export function repoChoices(ctx: RepoContext, teamName: string): Choice<RepoChoice>[] {
  const choices: Choice<RepoChoice>[] = [];
  if (ctx.slug) choices.push({ value: 'link', label: `Link this repo (${ctx.slug})` });
  if (ctx.hasGh && !ctx.isGit) {
    const bad = (() => { try { validateNewRepoArgs(teamName); return undefined; } catch (e) { return (e as Error).message; } })();
    choices.push({ value: 'new', label: `Create a new GitHub repo ./${teamName}`, hint: bad, disabled: Boolean(bad) });
  }
  const where = ctx.isGit ? 'this git repo, no GitHub link' : 'tied to this directory';
  choices.push({ value: 'local', label: 'Local only', hint: where });
  return choices;
}

export interface CreateAnswers { name: string; agent: ToolKind; repo: RepoChoice; visibility?: 'private' | 'public'; hub: string; as?: string }

/** Menu answers → the options object `agentteams create` builds from its flags. */
export function createOptions(a: CreateAnswers): CreateOpts {
  return {
    agent: a.agent, hub: a.hub, install: true,
    ...(a.as ? { as: a.as } : {}),
    ...(a.repo === 'local' ? { local: true } : {}),
    ...(a.repo === 'new' ? { newRepo: true, visibility: a.visibility ?? 'private' } : {}),
  };
}

export interface JoinAnswers { code: string; agent: ToolKind; hub: string; clone: boolean; as?: string }

/** Menu answers → the options object `agentteams join` builds from its flags. */
export function joinOptions(a: JoinAnswers): { code: string; opts: JoinOpts } {
  return { code: a.code.trim(), opts: { agent: a.agent, hub: a.hub, install: true, clone: a.clone, ...(a.as ? { as: a.as } : {}) } };
}

export function validateMemberName(v: string): string | undefined {
  return MemberName.safeParse(v).success ? undefined : 'use 1-24 characters: a-z, 0-9 or _';
}
