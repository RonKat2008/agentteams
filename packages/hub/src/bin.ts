#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadHubConfig, type HubConfig } from './config.js';
import { startHub } from './server.js';

const fail = (message: string): never => {
  console.error(`agentteams-hub: ${message}`);
  process.exit(1);
};

let config: HubConfig;
try {
  config = loadHubConfig(process.env, homedir());
} catch (err) {
  config = fail((err as Error).message);
}
mkdirSync(config.home, { recursive: true, mode: 0o700 });

const hub = await startHub({
  dbPath: join(config.home, 'hub.db'),
  databaseUrl: config.databaseUrl,
  port: config.port,
  host: config.host,
  mode: config.mode,
  allowedHosts: config.allowedHosts,
}).catch((err: Error) => fail(`failed to start: ${err.message}`));
// Never log DATABASE_URL or other secrets.
console.log(
  config.mode === 'hosted'
    ? `agentteams hub (hosted) listening on ${hub.url}`
    : `agentteams hub listening on ${hub.url} (data: ${config.home})`,
);

const shutdown = () => {
  hub.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
