import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import type { ToolKind } from '@agentteams/shared';
import type { CliDeps } from './deps.js';
import { credentialsPath } from './paths.js';

export interface Credential {
  repoPath: string;
  tool: ToolKind;
  hubUrl: string;
  teamName: string;
  agentName: string;
  apiKey: string;
  createdAt: string;
}

interface CredentialsFile { version: 1; credentials: Credential[] }
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
  try {
    return (JSON.parse(text) as CredentialsFile).credentials ?? [];
  } catch {
    throw new Error(`${file}: credentials.json is not valid JSON; fix or delete it`);
  }
}

const sameSlot = (a: Credential, b: Credential) => a.repoPath === b.repoPath && a.tool === b.tool;

export async function saveCredential(deps: Deps, cred: Credential): Promise<void> {
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
  const matches = (await loadCredentials(deps))
    .filter((c) => (tool ? c.tool === tool : true) && contains(c.repoPath, cwd))
    .sort((a, b) => b.repoPath.length - a.repoPath.length);
  return matches[0] ?? null;
}
