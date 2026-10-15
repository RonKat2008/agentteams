import { DEFAULT_HUB_PORT } from '@agentteams/shared';

const MAX_PORT = 65535;

export function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_HUB_PORT;
  const port = Number(value);
  if (value.trim() === '' || !Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`AGENTTEAMS_PORT must be an integer between 1 and 65535 (got "${value}")`);
  }
  return port;
}
