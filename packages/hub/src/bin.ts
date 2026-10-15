#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HUB_PORT } from '@agentteams/shared';
import { startHub } from './server.js';

const home = process.env.AGENTTEAMS_HOME ?? join(homedir(), '.agentteams');
mkdirSync(home, { recursive: true, mode: 0o700 });
const port = Number(process.env.AGENTTEAMS_PORT ?? DEFAULT_HUB_PORT);

const hub = await startHub({ dbPath: join(home, 'hub.db'), port });
console.log(`agentteams hub listening on ${hub.url} (data: ${home})`);

const shutdown = () => {
  hub.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
