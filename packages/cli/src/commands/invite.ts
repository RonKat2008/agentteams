import type { ToolKind } from '@agentteams/shared';
import type { CliDeps } from '../deps.js';
import { clientFor, dateOnly, requireCredential } from './shared.js';

export async function inviteCommand(deps: CliDeps, action: 'rotate' | 'revoke', opts: { agent?: ToolKind }): Promise<void> {
  const client = clientFor(deps, await requireCredential(deps, opts.agent));
  if (action === 'rotate') {
    const res = await client.rotateInvite();
    deps.out(`New invite code: ${res.inviteCode} (expires ${dateOnly(res.inviteExpiresAt)})`);
  } else {
    await client.revokeInvite();
    deps.out('Invite code revoked.');
  }
}
