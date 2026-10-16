import { isAbsolute, join } from 'node:path';
import { DEFAULT_HUB_PORT } from '@agentteams/shared';


const MAX_PORT = 65535;

/** AGENTTEAMS_HOME: unset or empty means the default; anything else must be an absolute path. */
export function resolveHome(value: string | undefined, homeDir: string): string {
  if (value === undefined || value === '') return join(homeDir, '.agentteams');
  if (!isAbsolute(value)) throw new Error('AGENTTEAMS_HOME must be an absolute path');
  return value;
}

export function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_HUB_PORT;
  const port = Number(value);
  if (value.trim() === '' || !Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`AGENTTEAMS_PORT must be an integer between 1 and 65535 (got "${value}")`);
  }
  return port;
}

export interface HubConfig {
  mode: 'local' | 'hosted';
  host: string;
  port: number;
  home: string;
  databaseUrl?: string;
  allowedHosts: string[];
}

const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

function parseMode(value: string | undefined): 'local' | 'hosted' {
  if (value === undefined || value === '' || value === 'local') return 'local';
  if (value === 'hosted') return 'hosted';
  throw new Error(`AGENTTEAMS_MODE must be "local" or "hosted" (got "${value}")`);
}

/** Reads the hub's environment into a validated config; throws with a clear message on bad input. */
export function loadHubConfig(env: NodeJS.ProcessEnv, homeDir: string): HubConfig {
  const mode = parseMode(env.AGENTTEAMS_MODE);
  const listed = (env.AGENTTEAMS_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter((h) => h !== '');
  if (mode === 'hosted' && listed.length === 0) throw new Error('AGENTTEAMS_ALLOWED_HOSTS is required in hosted mode');
  return {
    mode,
    host: env.AGENTTEAMS_HOST || '127.0.0.1',
    port: parsePort(env.AGENTTEAMS_PORT),
    home: resolveHome(env.AGENTTEAMS_HOME, homeDir),
    databaseUrl: env.DATABASE_URL || undefined,
    allowedHosts: listed.length > 0 ? listed : LOCAL_HOSTS,
  };
}
