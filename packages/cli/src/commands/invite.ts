import type { ToolKind } from '@agentteams/shared';
import { saveCredential, type Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { INVITE_WARNING, inviteCodeOf } from '../git/setup.js';
import { LOCAL_TEAM_LABEL } from '../local/team.js';
import { printInvite, teammateJoinCommand } from './create.js';
import { clientFor, dateOnly, requireCredential } from './shared.js';

export type InviteAction = 'show' | 'rotate' | 'revoke';

/** Git teams: access is the repo's access, and the code is the team key, which cannot be changed in place. */
export const GIT_INVITE_EXPLANATION =
  'this team is shared through git: anyone with the invite code AND access to the repo can read and join it. ' +
  'To keep someone out, remove their access to the repo (on GitHub: Settings > Collaborators). ' +
  'A new code would need a new team key, i.e. a new team, which agentteams does not support yet. ' +
  'Run "agentteams invite show" to print the current code.';

/** The credential with its stored invite replaced (or dropped when `invite` is undefined). */
const withInvite = (cred: Credential, invite: Credential['invite']): Credential => {
  const { invite: _old, ...rest } = cred;
  return invite ? { ...rest, invite } : rest;
};

/** The hub stores invite codes hashed; the creator's credential keeps the plaintext so it can be shown again. */
function showStoredInvite(deps: CliDeps, cred: Credential, hubUrl: string): void {
  const stored = cred.invite;
  if (stored === undefined) {
    throw new Error(
      'the invite code is not stored in this credential (teams created by an older agentteams, and joiners, do not have it). ' +
      'Run "agentteams invite --rotate" for a new one.');
  }
  if (Date.parse(stored.expiresAt) <= Date.now()) {
    throw new Error(`the invite code expired on ${dateOnly(stored.expiresAt)}; run "agentteams invite --rotate" for a new one`);
  }
  deps.out(`Team "${cred.teamName}"`);
  printInvite(deps, stored.code, stored.expiresAt, hubUrl);
  if (cred.transport === 'local') deps.out(LOCAL_TEAM_LABEL);
}

export async function inviteCommand(deps: CliDeps, action: InviteAction, opts: { agent?: ToolKind }): Promise<void> {
  const cred = await requireCredential(deps, opts.agent);
  if (cred.transport === 'git') {
    if (action !== 'show') throw new Error(`cannot ${action} the invite: ${GIT_INVITE_EXPLANATION}`);
    const { code, url } = await inviteCodeOf(deps, cred);
    deps.out(`Team "${cred.teamName}" (shared through ${url})`);
    deps.out(`Teammates join with: ${teammateJoinCommand(code, '')}`);
    deps.out(INVITE_WARNING);
    return;
  }
  const hubUrl = cred.transport === 'local' ? '' : cred.hubUrl;
  if (action === 'show') return showStoredInvite(deps, cred, hubUrl);
  const client = clientFor(deps, cred);
  if (action === 'rotate') {
    const res = await client.rotateInvite();
    await saveCredential(deps, withInvite(cred, { code: res.inviteCode, expiresAt: res.inviteExpiresAt }));
    printInvite(deps, res.inviteCode, res.inviteExpiresAt, hubUrl, 'New invite code');
  } else {
    await client.revokeInvite();
    await saveCredential(deps, withInvite(cred, undefined));
    deps.out('Invite code revoked.');
  }
}
