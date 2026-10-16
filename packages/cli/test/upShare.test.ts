import { request } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { upCommand } from '../src/commands/up.js';
import type { TunnelHandle, TunnelStarter } from '../src/tunnel.js';
import { makeTestCli, type TestCli } from './helpers.js';

const TUNNEL_URL = 'https://fake-share-abc.trycloudflare.com';
const clis: TestCli[] = [];
const dirs: string[] = [];
afterEach(() => {
  clis.splice(0).forEach((c) => c.cleanup());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const mk = (): TestCli => {
  const home = mkdtempSync(join(tmpdir(), 'agentteams-up-'));
  dirs.push(home);
  const t = makeTestCli({ env: { AGENTTEAMS_HOME: home } });
  clis.push(t);
  return t;
};

const wait = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
};

/** GET /health with an explicit Host header (fetch cannot set Host). */
function get(base: string, host: string, path = '/health'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = request({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function fakeTunnel(): { starter: TunnelStarter; localUrls: string[]; stopped: () => number } {
  const localUrls: string[] = [];
  let stops = 0;
  const starter: TunnelStarter = async (localUrl) => {
    localUrls.push(localUrl);
    const handle: TunnelHandle = { url: TUNNEL_URL, stop: async () => { stops++; }, exited: new Promise<void>(() => {}) };
    return handle;
  };
  return { starter, localUrls, stopped: () => stops };
}

describe('up (plain)', () => {
  it('prints that teams on this hub use --hub local', async () => {
    const t = mk();
    const ac = new AbortController();
    const done = upCommand(t.deps, { port: '0', signal: ac.signal });
    await wait(() => t.out.some((l) => l.includes('--hub')));
    ac.abort();
    await done;
    expect(t.out.join('\n')).toMatch(/--hub (local|http:\/\/127\.0\.0\.1:\d+)/);
  });
});

describe('up --share', () => {
  it('runs a hosted hub bound to loopback, allowing only the tunnel host, and prints the commands', async () => {
    const t = mk();
    const tun = fakeTunnel();
    const ac = new AbortController();
    const done = upCommand(t.deps, { port: '0', share: true, signal: ac.signal, tunnel: tun.starter });
    await wait(() => t.out.some((l) => l.includes(TUNNEL_URL)));
    const out = t.out.join('\n');
    expect(tun.localUrls).toHaveLength(1);
    const local = tun.localUrls[0]!;
    expect(local).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(out).toContain(`agentteams create <team-name> --hub ${TUNNEL_URL}`);
    expect(out).toContain(`agentteams join <invite-code> --hub ${TUNNEL_URL}`);

    const ok = await get(local, 'fake-share-abc.trycloudflare.com');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ mode: 'hosted' });
    // The Host allowlist: only the tunnel hostname passes (unknown route -> 404; other hosts -> 403).
    expect((await get(local, 'fake-share-abc.trycloudflare.com', '/nope')).status).toBe(404);
    expect((await get(local, '127.0.0.1', '/nope')).status).toBe(403);
    expect((await get(local, 'evil.example.com', '/nope')).status).toBe(403);

    expect(out).toContain('this URL changes every time you restart');
    expect(existsSync(join(t.deps.env.AGENTTEAMS_HOME!, 'share.db'))).toBe(true);
    expect(existsSync(join(t.deps.env.AGENTTEAMS_HOME!, 'hub.db'))).toBe(false);

    ac.abort();
    await done;
    expect(tun.stopped()).toBe(1);
    await expect(get(local, 'fake-share-abc.trycloudflare.com')).rejects.toThrow();
  });

  it('reports a clear error, stops nothing it did not start, and leaves no hub when the tunnel fails', async () => {
    const t = mk();
    const starter: TunnelStarter = async () => { throw new Error('could not download cloudflared'); };
    await expect(upCommand(t.deps, { port: '0', share: true, tunnel: starter })).rejects.toThrow(/tunnel.*could not download cloudflared/is);
    expect(t.out.join('\n')).not.toContain('listening');
  });

  it('shuts the tunnel down if the hub cannot start', async () => {
    const t = mk();
    const tun = fakeTunnel();
    // Occupy a port, then ask --share to use it.
    const { createServer } = await import('node:net');
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(upCommand(t.deps, { port: String(port), share: true, tunnel: tun.starter })).rejects.toThrow();
      expect(tun.stopped()).toBe(1);
    } finally {
      blocker.close();
    }
  });

  it('stops the hub when the tunnel process exits on its own', async () => {
    const t = mk();
    let exit!: () => void;
    const exited = new Promise<void>((r) => { exit = r; });
    const starter: TunnelStarter = async () => ({ url: TUNNEL_URL, stop: async () => {}, exited });
    const done = upCommand(t.deps, { port: '0', share: true, tunnel: starter });
    await wait(() => t.out.some((l) => l.includes(TUNNEL_URL)));
    exit();
    await done;
    expect(t.err.join('\n')).toMatch(/tunnel.*(closed|exited)/i);
  });
});
