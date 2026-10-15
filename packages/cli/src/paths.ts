import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliDeps } from './deps.js';

export const DEFAULT_HUB_URL = 'http://127.0.0.1:4747';

type HomeDeps = Pick<CliDeps, 'env' | 'homedir'>;

export const agentteamsHome = (d: HomeDeps): string => d.env.AGENTTEAMS_HOME ?? join(d.homedir, '.agentteams');
export const credentialsPath = (d: HomeDeps): string => join(agentteamsHome(d), 'credentials.json');
export const codexHome = (d: HomeDeps): string => d.env.CODEX_HOME ?? join(d.homedir, '.codex');

export function hubUrlFrom(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  return (flag ?? env.AGENTTEAMS_HUB ?? DEFAULT_HUB_URL).replace(/\/+$/, '');
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const binPath = (): string => fileURLToPath(new URL('./bin.js', import.meta.url));

/** Shell command that re-invokes this CLI (used inside hook configs). */
export function cliCommand(): string {
  return `${shellQuote(process.execPath)} ${shellQuote(binPath())}`;
}

/** The same invocation as argv parts (for TOML command/args). */
export function cliArgv(): { command: string; args: string[] } {
  return { command: process.execPath, args: [binPath()] };
}
