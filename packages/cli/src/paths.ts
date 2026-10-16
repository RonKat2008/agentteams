import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliDeps } from './deps.js';

/** The public hub teams use when no --hub / AGENTTEAMS_HUB is given. */
export const DEFAULT_HUB_URL = 'https://agentteams-two.vercel.app';
/** What `--hub local` means: the hub started by `agentteams up`. */
export const LOCAL_HUB_URL = 'http://127.0.0.1:4747';

type HomeDeps = Pick<CliDeps, 'env' | 'homedir'>;

/** AGENTTEAMS_HOME: unset or empty means the default; anything else must be an absolute path. */
export function agentteamsHome(d: HomeDeps): string {
  const v = d.env.AGENTTEAMS_HOME;
  if (v === undefined || v === '') return join(d.homedir, '.agentteams');
  if (!isAbsolute(v)) throw new Error('AGENTTEAMS_HOME must be an absolute path');
  return v;
}
export const credentialsPath = (d: HomeDeps): string => join(agentteamsHome(d), 'credentials.json');
export const codexHome = (d: HomeDeps): string => d.env.CODEX_HOME ?? join(d.homedir, '.codex');

export function hubUrlFrom(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.AGENTTEAMS_HUB === '' ? undefined : env.AGENTTEAMS_HUB;
  const raw = (flag ?? fromEnv ?? DEFAULT_HUB_URL).trim();
  if (raw.toLowerCase() === 'local') return LOCAL_HUB_URL;
  return raw.replace(/\/+$/, '');
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
