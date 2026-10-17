import type { ToolKind } from '@agentteams/shared';
import type { CliDeps } from '../deps.js';
import { oneLine } from '../format.js';
import { validSlug } from './join.js';
import { clientFor, readableTeams } from './shared.js';

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';

const isCi = (v: string | undefined): boolean => v === 'true' || v === '1';

export async function accessGrantCommand(
  deps: CliDeps, target: string, opts: { yes?: boolean; agent?: ToolKind },
): Promise<void> {
  const { cred } = (await readableTeams(deps, opts.agent))[0]!; // only reads team status
  const status = await clientFor(deps, cred).status();
  const { repo } = status.team;
  if (repo.provider !== 'github') throw new Error('access grant needs a team linked to a GitHub repo');
  const slug = validSlug(repo.slug);
  const wanted = target.replace(/^@/, '').toLowerCase();
  const matches = status.agents.filter((a) => a.name.toLowerCase() === wanted || a.githubLogin?.toLowerCase() === wanted);
  const first = matches[0];
  if (!first) throw new Error(`no agent or GitHub login "${oneLine(target).slice(0, 80)}" in this team`);
  const logins = new Map<string, string>();
  for (const m of matches) if (m.githubLogin) logins.set(m.githubLogin.toLowerCase(), m.githubLogin);
  if (logins.size > 1) {
    const shown = [...logins.values()].map((l) => oneLine(l).slice(0, 40)).join(', ');
    throw new Error(`"${oneLine(target).slice(0, 80)}" matches more than one GitHub user (${shown}); use the agent name`);
  }
  const login = [...logins.values()][0];
  if (!login) throw new Error(`${oneLine(first.name)} has no GitHub identity (local-mode join)`);
  if (!LOGIN_RE.test(login)) throw new Error('the hub returned an invalid GitHub login');

  if (deps.isTTY) {
    const answer = (await deps.prompt(`Grant push access to ${slug} for GitHub user ${login}? [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      deps.out('Cancelled; no access granted.');
      return;
    }
  } else if (!(opts.yes && deps.env.AGENTTEAMS_ALLOW_GRANT === '1' && isCi(deps.env.CI))) {
    throw new Error('access grant needs a human: run it in your own terminal (agents cannot grant repo access)');
  }
  const res = await deps.exec('gh', ['api', '-X', 'PUT', `repos/${slug}/collaborators/${login}`, '-f', 'permission=push']);
  if (res.code !== 0) {
    throw new Error(`could not invite @${login} to ${slug}: ${firstLine(res.stderr) || firstLine(res.stdout) || 'unknown error'}`);
  }
  deps.out(`Invited @${login} to ${slug} with push access (they must accept the GitHub invitation).`);
}
