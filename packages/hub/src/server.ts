import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { DEFAULT_HUB_PORT } from '@agentteams/shared';
import { createContext } from './context.js';
import { migrateToLatest } from './db/migrations.js';
import { createSqliteDb } from './db/sqlite.js';
import { createApp } from './http/app.js';

export interface HubOptions {
  dbPath: string;
  port?: number;
  host?: string;
}

export interface RunningHub {
  url: string;
  close: () => Promise<void>;
}

export async function startHub(opts: HubOptions): Promise<RunningHub> {
  const db = createSqliteDb(opts.dbPath);
  await migrateToLatest(db);
  const app = createApp(createContext(db));
  const hostname = opts.host ?? '127.0.0.1';

  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? DEFAULT_HUB_PORT, hostname }, (info: AddressInfo) => {
      resolve({
        url: `http://${hostname}:${info.port}`,
        close: () =>
          new Promise<void>((res, rej) => {
            (server as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close((err) => (err ? rej(err) : res()));
          }).then(() => db.destroy()),
      });
    });
    server.once('error', (err) => {
      db.destroy().then(() => reject(err), () => reject(err));
    });
  });
}
