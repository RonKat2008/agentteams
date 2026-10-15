#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parsePort } from './config.js';
import { startHub } from './server.js';

const home = process.env.AGENTTEAMS_HOME ?? join(homedir(), '.agentteams');
mkdirSync(home, { recursive: true, mode: 0o700 });

const fail = (message: string): never => {
  console.error(`agentteams-hub: ${message}`);
  process.exit(1);
};

let port: number;
try {
  port = parsePort(process.env.AGENTTEAMS_PORT);
} catch (err) {
  port = fail((err as Error).message);
}

const hub = await startHub({ dbPath: join(home, 'hub.db'), port }).catch((err: Error) =>
  fail(`failed to start: ${err.message}`),
);
console.log(`agentteams hub listening on ${hub.url} (data: ${home})`);

const shutdown = () => {
  hub.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
