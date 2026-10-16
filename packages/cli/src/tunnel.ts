import { existsSync } from 'node:fs';
import type { EventEmitter } from 'node:events';

export interface TunnelHandle {
  /** Public https URL of the tunnel. */
  url: string;
  stop: () => Promise<void>;
  /** Resolves when the tunnel process ends on its own (not via stop). */
  exited: Promise<void>;
}

/** Starts a tunnel to a local URL (e.g. http://127.0.0.1:4747). Injectable so tests never spawn cloudflared. */
export type TunnelStarter = (localUrl: string) => Promise<TunnelHandle>;

/** The subset of the `cloudflared` npm package we use. */
export interface CloudflaredModule {
  bin: string;
  install: (to: string) => Promise<string>;
  Tunnel: { quick: (url: string) => EventEmitter & { stop: () => boolean } };
}

export const TUNNEL_START_TIMEOUT_MS = 45_000;
const QUICK_TUNNEL_URL = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

async function loadCloudflared(): Promise<CloudflaredModule> {
  let mod: unknown;
  try {
    mod = await import('cloudflared');
  } catch {
    throw new Error('the "cloudflared" package is not installed (it is an optional dependency); run: npm i -g cloudflared');
  }
  const m = mod as { default?: CloudflaredModule } & Partial<CloudflaredModule>;
  return (m.default ?? m) as CloudflaredModule;
}

export interface RealTunnelOptions {
  load?: () => Promise<CloudflaredModule>;
  timeoutMs?: number;
}

/** Cloudflare quick tunnel via the optional `cloudflared` package; fetches the binary on first use. */
export function realTunnelStarter(opts: RealTunnelOptions = {}): TunnelStarter {
  return async (localUrl) => {
    const cf = await (opts.load ?? loadCloudflared)();
    if (!existsSync(cf.bin)) {
      try {
        await cf.install(cf.bin);
      } catch (e) {
        throw new Error(`could not download the cloudflared binary (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    const tunnel = cf.Tunnel.quick(localUrl);
    let exitedFlag = false;
    let stopping = false;
    const exited = new Promise<void>((resolve) => {
      tunnel.once('exit', () => { exitedFlag = true; if (!stopping) resolve(); });
    });
    const stop = async (): Promise<void> => {
      stopping = true;
      if (!exitedFlag) tunnel.stop();
    };
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the tunnel URL')), opts.timeoutMs ?? TUNNEL_START_TIMEOUT_MS);
      const fail = (e: Error): void => { clearTimeout(timer); reject(e); };
      tunnel.once('url', (u: string) => { clearTimeout(timer); resolve(u.replace(/\/+$/, '')); });
      tunnel.once('error', (e: Error) => fail(e));
      tunnel.once('exit', (code: number | null) => fail(new Error(`cloudflared exited early (code ${code ?? 'null'})`)));
    }).catch(async (e: unknown) => {
      await stop();
      throw e;
    });
    if (!QUICK_TUNNEL_URL.test(url)) {
      await stop();
      throw new Error(`unexpected tunnel URL "${url}"`);
    }
    return { url, stop, exited };
  };
}
