import type { ToolKind } from '@agentteams/shared';
import type { CliDeps } from '../deps.js';
import { oneLine } from '../format.js';
import { validSlug } from './join.js';
import { clientFor, requireCredential } from './shared.js';

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';

export async function accessGrantCommand(
  deps: CliDeps, target: string, opts: { yes?: boolean; agent?: ToolKind },
): Promise<void> {
  const cred = await requireCredential(deps, opts.agent);
  const status = await clientFor(deps, cred).status();
  const { repo } = status.team;
  if (repo.provider !== 'github') throw new Error('access grant needs a team linked to a GitHub repo');
  const slug = validSlug(repo.slug);
  const wanted = target.replace(/^@/, '').toLowerCase();
  const agent = status.agents.find((a) => a.name.toLowerCase() === wanted || a.githubLogin?.toLowerCase() === wanted);
  if (!agent) throw new Error(`no agent or GitHub login "${oneLine(target).slice(0, 80)}" in this team`);
  const login = agent.githubLogin;
  if (!login) throw new Error(`${oneLine(agent.name)} has no GitHub identity (local-mode join)`);
  if (!LOGIN_RE.test(login)) throw new Error('the hub returned an invalid GitHub login');

  if (!opts.yes) {
    if (!deps.isTTY) throw new Error('refusing to grant access without confirmation; re-run with --yes');
    const answer = (await deps.prompt(`Grant push access to ${slug} for GitHub user ${login}? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      deps.out('Cancelled; no access granted.');
      return;
    }
  }
  const res = await deps.exec('gh', ['api', '-X', 'PUT', `repos/${slug}/collaborators/${login}`, '-f', 'permission=push']);
  if (res.code !== 0) {
    throw new Error(`could not invite @${login} to ${slug}: ${firstLine(res.stderr) || firstLine(res.stdout) || 'unknown error'}`);
  }
  deps.out(`Invited @${login} to ${slug} with push access (they must accept the GitHub invitation).`);
}
