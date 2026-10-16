import { isAbsolute, join } from 'node:path';
import { DEFAULT_HUB_PORT } from '@agentteams/shared';
import type { IpSource } from './http/limits.js';


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
  /** Which header, if any, carries the trusted client IP (hosted mode only). */
  ipSource: IpSource;
}

/** Host names (no scheme) Vercel gives this deployment: the production alias and the unique deployment URL. */
function vercelHosts(env: NodeJS.ProcessEnv): string[] {
  return [env.VERCEL_PROJECT_PRODUCTION_URL, env.VERCEL_URL, env.VERCEL_BRANCH_URL]
    .map((u) => (u ?? '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, ''))
    .filter((h) => h !== '');
}

const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

function parseMode(value: string | undefined): 'local' | 'hosted' {
  if (value === undefined || value === '' || value === 'local') return 'local';
  if (value === 'hosted') return 'hosted';
  throw new Error(`AGENTTEAMS_MODE must be "local" or "hosted" (got "${value}")`);
}

const HEADER_NAME = /^[a-z0-9-]+$/;

function parseIpSource(env: NodeJS.ProcessEnv, mode: 'local' | 'hosted'): IpSource {
  if (mode !== 'hosted') return 'socket';
  if (env.VERCEL === '1') return 'vercel';
  if ((env.FLY_APP_NAME ?? '') !== '') return 'fly';
  const header = (env.AGENTTEAMS_TRUSTED_IP_HEADER ?? '').trim();
  if (header === '') return 'socket';
  if (!HEADER_NAME.test(header)) {
    throw new Error(`AGENTTEAMS_TRUSTED_IP_HEADER must be a lowercase header name (got "${header}")`);
  }
  return { header };
}

/** Reads the hub's environment into a validated config; throws with a clear message on bad input. */
export function loadHubConfig(env: NodeJS.ProcessEnv, homeDir: string): HubConfig {
  const mode = parseMode(env.AGENTTEAMS_MODE);
  const explicit = (env.AGENTTEAMS_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter((h) => h !== '');
  const listed = explicit.length > 0 || mode !== 'hosted' || env.VERCEL !== '1' ? explicit : vercelHosts(env);
  if (mode === 'hosted' && listed.length === 0) throw new Error('AGENTTEAMS_ALLOWED_HOSTS is required in hosted mode');
  return {
    mode,
    host: env.AGENTTEAMS_HOST || '127.0.0.1',
    port: parsePort(env.AGENTTEAMS_PORT),
    home: resolveHome(env.AGENTTEAMS_HOME, homeDir),
    databaseUrl: env.DATABASE_URL || undefined,
    allowedHosts: listed.length > 0 ? listed : LOCAL_HOSTS,
    ipSource: parseIpSource(env, mode),
  };
}
