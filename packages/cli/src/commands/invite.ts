import type { ToolKind } from '@agentteams/shared';
import type { CliDeps } from '../deps.js';
import { INVITE_WARNING, inviteCodeOf } from '../git/setup.js';
import { teammateJoinCommand } from './create.js';
import { clientFor, dateOnly, requireCredential } from './shared.js';

export type InviteAction = 'show' | 'rotate' | 'revoke';

/** Git teams: access is the repo's access, and the code is the team key, which cannot be changed in place. */
export const GIT_INVITE_EXPLANATION =
  'this team is shared through git: anyone with the invite code AND access to the repo can read and join it. ' +
  'To keep someone out, remove their access to the repo (on GitHub: Settings > Collaborators). ' +
  'A new code would need a new team key, i.e. a new team, which agentteams does not support yet. ' +
  'Run "agentteams invite show" to print the current code.';

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
  if (action === 'show') {
    throw new Error('invite codes for this team are stored hashed and cannot be shown again; run "agentteams invite rotate" for a new one');
  }
  const client = clientFor(deps, cred);
  if (action === 'rotate') {
    const res = await client.rotateInvite();
    deps.out(`New invite code: ${res.inviteCode} (expires ${dateOnly(res.inviteExpiresAt)})`);
  } else {
    await client.revokeInvite();
    deps.out('Invite code revoked.');
  }
}
