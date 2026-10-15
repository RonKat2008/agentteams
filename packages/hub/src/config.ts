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
