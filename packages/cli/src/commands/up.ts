import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { parsePort, startHub, type RunningHub } from '@agentteams/hub';
import type { CliDeps } from '../deps.js';
import { LOCAL_HUB_URL, agentteamsHome } from '../paths.js';
import { realTunnelStarter, type TunnelHandle, type TunnelStarter } from '../tunnel.js';

/** Port 0 (ephemeral) is allowed here even though the hub's env parser rejects it. */
const portFrom = (raw: string | undefined): number => (raw?.trim() === '0' ? 0 : parsePort(raw));

/** Header Cloudflare sets (and overwrites) with the real client IP; the hub only listens on loopback behind the tunnel. */
const CLOUDFLARE_IP_HEADER = 'cf-connecting-ip';
/** --share keeps its own database so internet-exposed teams never mix with the local hub's (`--hub local`) teams. */
export const SHARE_DB = 'share.db';

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

/** An unused loopback port (the tunnel needs the port before the hub, which needs the tunnel hostname). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export interface UpOptions {
  port?: string;
  share?: boolean;
  signal?: AbortSignal;
  /** Tunnel starter for --share; defaults to a Cloudflare quick tunnel. Tests inject a fake. */
  tunnel?: TunnelStarter;
}

async function ensureHome(deps: CliDeps): Promise<string> {
  const home = agentteamsHome(deps);
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

async function upLocal(deps: CliDeps, opts: UpOptions): Promise<void> {
  const home = await ensureHome(deps);
  const hub = await startHub({ dbPath: join(home, 'hub.db'), port: portFrom(opts.port ?? deps.env.AGENTTEAMS_PORT) });
  deps.out(`agentteams hub listening on ${hub.url} (data: ${home})`);
  const flag = hub.url === LOCAL_HUB_URL ? 'local' : hub.url;
  deps.out(`Teams on this hub use: --hub ${flag}${flag === 'local' ? ' (or AGENTTEAMS_HUB=local)' : ''}`);
  deps.out('To let teammates connect over the internet instead, run: agentteams up --share');
  await untilStopped(opts.signal);
  await hub.close();
}

async function startTunnel(starter: TunnelStarter, localUrl: string): Promise<TunnelHandle> {
  try {
    return await starter(localUrl);
  } catch (e) {
    throw new Error(`could not start the share tunnel: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function upShare(deps: CliDeps, opts: UpOptions): Promise<void> {
  const home = await ensureHome(deps);
  const requested = portFrom(opts.port ?? deps.env.AGENTTEAMS_PORT);
  const port = requested === 0 ? await freePort() : requested;
  const tunnel = await startTunnel(opts.tunnel ?? realTunnelStarter({ log: deps.out }), `http://127.0.0.1:${port}`);
  let hub: RunningHub;
  try {
    hub = await startHub({
      dbPath: join(home, SHARE_DB),
      host: '127.0.0.1',
      port,
      mode: 'hosted',
      allowedHosts: [new URL(tunnel.url).hostname],
      ipSource: { header: CLOUDFLARE_IP_HEADER },
    });
  } catch (e) {
    await tunnel.stop();
    throw e;
  }
  deps.out(`agentteams hub listening on ${hub.url} (hosted mode, data: ${join(home, SHARE_DB)})`);
  deps.out(`Public URL: ${tunnel.url}`);
  deps.out('Anyone with the URL and an invite code can join, and must sign in with GitHub (gh auth login).');
  deps.out(`Create a team:  agentteams create <team-name> --hub ${tunnel.url}`);
  deps.out(`Teammates join: agentteams join <invite-code> --hub ${tunnel.url}`);
  deps.out('Note: this URL changes every time you restart --share; teammates must re-join after a restart (or keep this running).');
  deps.out('Press Ctrl-C to stop sharing.');
  const tunnelDied = tunnel.exited.then(() => {
    deps.err('The share tunnel closed unexpectedly; stopping the hub.');
  });
  await Promise.race([untilStopped(opts.signal), tunnelDied]);
  await tunnel.stop();
  await hub.close();
}

export function upCommand(deps: CliDeps, opts: UpOptions): Promise<void> {
  return opts.share ? upShare(deps, opts) : upLocal(deps, opts);
}
