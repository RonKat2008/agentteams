import { chmod, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import type { ToolKind } from '@agentteams/shared';
import type { CliDeps } from './deps.js';
import { mainRepoRoot } from './git.js';
import { credentialsPath } from './paths.js';

/**
 * Git-transport identity, stored inside the credential (credentials.json is 0600 in a 0700 directory).
 * `teamKey` encrypts the team log; `privateKey` signs this agent's segments. Both are secrets.
 */
export interface GitCredential {
  teamId: string;
  /** This agent's id: the ULID of its own bootstrap (createTeam/join) op. */
  agentId: string;
  /** The team's git remote (URL or path) that carries refs/agentteams/<teamId>/*. */
  remote: string;
  teamKey: string;
  publicKey: string;
  privateKey: string;
  /**
   * The team's creator (agent id and public key), from the invite, or this agent itself for the creator. Pinned
   * before every round's fetch, so no clone of this credential trusts a forged team meta on first sight.
   */
  creator?: { agentId: string; publicKey: string };
}

export interface Credential {
  repoPath: string;
  tool: ToolKind;
  hubUrl: string;
  teamName: string;
  agentName: string;
  apiKey: string;
  createdAt: string;
  /** Absent means http. Only persisted when not http. */
  transport?: 'http' | 'local' | 'git';
  /** Required when transport is 'git'. */
  git?: GitCredential;
  /**
   * The creator's current hub/local invite code in plaintext (the hub stores only a hash), so `agentteams invite`
   * can show it again. A secret like the API key: credentials.json is 0600 and never committed.
   */
  invite?: StoredInvite;
}

export interface StoredInvite { code: string; expiresAt: string }

interface CredentialsFile { version: 1; credentials: Credential[] }

const TRANSPORTS: readonly string[] = ['http', 'local', 'git'];

/** An unknown transport must never fall back to http: that would send the API key to whatever hubUrl holds. */
function checkTransports(file: string, credentials: Credential[]): Credential[] {
  for (const c of credentials) {
    const t: unknown = c.transport;
    if (t !== undefined && !(typeof t === 'string' && TRANSPORTS.includes(t))) {
      throw new Error(
        `${file}: the ${c.tool} credential for ${c.repoPath} has an unknown transport ${JSON.stringify(t)} ` +
        '(expected "http", "local" or "git"); upgrade agentteams, or fix or remove that entry');
    }
  }
  return credentials;
}
type Deps = Pick<CliDeps, 'env' | 'homedir'>;

export async function loadCredentials(deps: Deps): Promise<Credential[]> {
  const file = credentialsPath(deps);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: CredentialsFile;
  try {
    parsed = JSON.parse(text) as CredentialsFile;
  } catch {
    throw new Error(`${file}: credentials.json is not valid JSON; fix or delete it`);
  }
  return checkTransports(file, parsed.credentials ?? []);
}

const sameSlot = (a: Credential, b: Credential) => a.repoPath === b.repoPath && a.tool === b.tool;

const real = (p: string): Promise<string> => realpath(p).catch(() => p);

export async function saveCredential(deps: Deps, input: Credential): Promise<void> {
  const { transport, ...rest } = input;
  const cred: Credential = { ...rest, repoPath: await real(input.repoPath), ...(transport && transport !== 'http' ? { transport } : {}) };
  const file = credentialsPath(deps);
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const existing = await loadCredentials(deps);
  const replaced = existing.some((c) => sameSlot(c, cred));
  const credentials = replaced ? existing.map((c) => (sameSlot(c, cred) ? cred : c)) : [...existing, cred];
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, credentials } satisfies CredentialsFile, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600);
}

const contains = (repoPath: string, cwd: string) =>
  cwd === repoPath || cwd.startsWith(repoPath.endsWith(sep) ? repoPath : repoPath + sep);

export async function resolveCredential(deps: Deps, cwd: string, tool?: ToolKind): Promise<Credential | null> {
  const here = await real(cwd);
  const matches = (await loadCredentials(deps))
    .filter((c) => (tool ? c.tool === tool : true) && contains(c.repoPath, here))
    .sort((a, b) => b.repoPath.length - a.repoPath.length);
  return matches[0] ?? null;
}

/** Like resolveCredential, but from a linked git worktree falls back to the main repo's credential. */
export async function resolveCredentialForCwd(
  deps: Deps & Pick<CliDeps, 'exec'>,
  cwd: string,
  tool?: ToolKind,
): Promise<Credential | null> {
  const direct = await resolveCredential(deps, cwd, tool);
  if (direct) return direct;
  const main = await mainRepoRoot(deps, cwd);
  if (!main) return null;
  const here = await real(cwd);
  if ((await real(main)) === here) return null;
  return resolveCredential(deps, main, tool);
}
