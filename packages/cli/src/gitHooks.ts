import { resolveCredentialForCwd, type Credential } from './credentials.js';
import type { CliDeps } from './deps.js';
import { oneLine } from './format.js';
import { headCommit, stagedFiles } from './git.js';
import { HubClient } from './hubClient.js';

export type { GitHookName } from './install/gitHooks.js';

const HOOK_TIMEOUT_MS = 2000;
const TOOL_ORDER = ['claude', 'codex', 'other'] as const;

type Deps = Pick<CliDeps, 'env' | 'homedir' | 'cwd' | 'fetch' | 'exec' | 'err'>;

/**
 * Git hooks are tool-agnostic: when several credentials match the repo, accept any of them,
 * preferring them in a fixed order (claude, codex, other) so the choice is deterministic.
 */
async function pickCredential(deps: Deps): Promise<Credential | null> {
  for (const tool of TOOL_ORDER) {
    const cred = await resolveCredentialForCwd(deps, deps.cwd, tool);
    if (cred) return cred;
  }
  return null;
}

const clientFor = (deps: Deps, cred: Credential): HubClient =>
  new HubClient(cred.hubUrl, { apiKey: cred.apiKey, timeoutMs: HOOK_TIMEOUT_MS, fetch: deps.fetch });

const message = (e: unknown): string => oneLine(e instanceof Error ? e.message : String(e));

const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? oneLine(iso) : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export async function runPreCommit(deps: Deps): Promise<number> {
  try {
    const cred = await pickCredential(deps);
    if (!cred) return 0;
    const paths = await stagedFiles(deps, deps.cwd);
    if (paths.length === 0) return 0;
    const client = clientFor(deps, cred);
    let conflicts;
    try {
      ({ conflicts } = await client.checkFiles(paths));
    } catch (e) {
      deps.err(`agentteams: warning: could not check file claims (${message(e)}); committing anyway`);
      return 0;
    }
    if (conflicts.length === 0) return 0;
    const owners = [...new Set(conflicts.map((c) => oneLine(c.agent)))].join(', ');
    if (deps.env.AGENTTEAMS_ALLOW === '1') {
      await client.claimOverride(paths).catch(() => undefined);
      deps.err(`agentteams: committing over claims held by ${owners} (AGENTTEAMS_ALLOW=1); they have been notified`);
      return 0;
    }
    deps.err([
      'agentteams: commit blocked — these staged files are claimed by other agents:',
      ...conflicts.map((c) => `  ${oneLine(c.path)}  (claimed by ${oneLine(c.agent)} via ${oneLine(c.glob)}, until ${hhmm(c.expiresAt)})`),
      'Ask them via send_message, wait for release, or override with: AGENTTEAMS_ALLOW=1 git commit ...',
    ].join('\n'));
    return 1;
  } catch (e) {
    deps.err(`agentteams: warning: claim check failed (${message(e)}); committing anyway`);
    return 0;
  }
}

export async function runPostCommit(deps: Deps): Promise<number> {
  try {
    const cred = await pickCredential(deps);
    if (!cred) return 0;
    const commit = await headCommit(deps, deps.cwd);
    await clientFor(deps, cred).recordCommit(commit);
  } catch (e) {
    deps.err(`agentteams: warning: could not record commit (${message(e)})`);
  }
  return 0;
}
