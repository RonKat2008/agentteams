import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePort, startHub } from '@agentteams/hub';
import type { CliDeps } from '../deps.js';
import { agentteamsHome } from '../paths.js';

/** Port 0 (ephemeral) is allowed here even though the hub's env parser rejects it. */
const portFrom = (raw: string | undefined): number => (raw?.trim() === '0' ? 0 : parsePort(raw));

function untilStopped(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal) {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
      return;
    }
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
}

export async function upCommand(deps: CliDeps, opts: { port?: string; signal?: AbortSignal }): Promise<void> {
  const home = agentteamsHome(deps);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const hub = await startHub({ dbPath: join(home, 'hub.db'), port: portFrom(opts.port ?? deps.env.AGENTTEAMS_PORT) });
  deps.out(`agentteams hub listening on ${hub.url} (data: ${home})`);
  await untilStopped(opts.signal);
  await hub.close();
}
