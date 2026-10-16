import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { realTunnelStarter, type CloudflaredModule } from '../src/tunnel.js';

function fakeCf(opts: { binExists?: boolean; installFails?: boolean } = {}) {
  const emitter = Object.assign(new EventEmitter(), { stopped: 0, stop() { this.stopped++; return true; } });
  const installs: string[] = [];
  const urls: string[] = [];
  const mod: CloudflaredModule = {
    bin: opts.binExists ? process.execPath : '/nonexistent/agentteams-test/cloudflared',
    install: async (to) => { installs.push(to); if (opts.installFails) throw new Error('offline'); return to; },
    Tunnel: { quick: (u) => { urls.push(u); return emitter; } },
  };
  return { mod, emitter, installs, urls };
}

describe('realTunnelStarter', () => {
  it('installs the binary when missing, resolves with the quick-tunnel url, and stops the process', async () => {
    const f = fakeCf();
    const p = realTunnelStarter({ load: async () => f.mod })('http://127.0.0.1:9');
    await new Promise((r) => setTimeout(r, 10));
    f.emitter.emit('url', 'https://abc-def.trycloudflare.com/');
    const h = await p;
    expect(h.url).toBe('https://abc-def.trycloudflare.com');
    expect(f.installs).toEqual([f.mod.bin]);
    expect(f.urls).toEqual(['http://127.0.0.1:9']);
    await h.stop();
    expect(f.emitter.stopped).toBe(1);
  });

  it('announces the first-use download and explains a missing optional package', async () => {
    const f = fakeCf();
    const lines: string[] = [];
    const p = realTunnelStarter({ load: async () => f.mod, log: (l) => lines.push(l) })('http://127.0.0.1:9');
    await new Promise((r) => setTimeout(r, 10));
    f.emitter.emit('url', 'https://abc.trycloudflare.com');
    await p;
    expect(lines.join('\n')).toMatch(/Downloading the cloudflared binary/);
    await expect(realTunnelStarter({ load: async () => { throw new Error('the "cloudflared" package is not installed'); } })('http://x')).rejects.toThrow(/not installed/);
  });

  it('skips the download when the binary exists', async () => {
    const f = fakeCf({ binExists: true });
    const p = realTunnelStarter({ load: async () => f.mod })('http://127.0.0.1:9');
    await new Promise((r) => setTimeout(r, 10));
    f.emitter.emit('url', 'https://abc.trycloudflare.com');
    await p;
    expect(f.installs).toEqual([]);
  });

  it('fails clearly when the binary cannot be downloaded', async () => {
    const f = fakeCf({ installFails: true });
    await expect(realTunnelStarter({ load: async () => f.mod })('http://127.0.0.1:9')).rejects.toThrow(/could not download the cloudflared binary \(offline\)/);
  });

  it('rejects, and kills the process, on early exit, timeout or a non-trycloudflare url', async () => {
    const early = fakeCf({ binExists: true });
    const p1 = realTunnelStarter({ load: async () => early.mod })('http://127.0.0.1:9');
    await new Promise((r) => setTimeout(r, 10));
    early.emitter.emit('exit', 1, null);
    await expect(p1).rejects.toThrow(/exited early/);

    const slow = fakeCf({ binExists: true });
    await expect(realTunnelStarter({ load: async () => slow.mod, timeoutMs: 20 })('http://127.0.0.1:9')).rejects.toThrow(/timed out/);
    expect(slow.emitter.stopped).toBe(1);

    const evil = fakeCf({ binExists: true });
    const p3 = realTunnelStarter({ load: async () => evil.mod })('http://127.0.0.1:9');
    await new Promise((r) => setTimeout(r, 10));
    evil.emitter.emit('url', 'https://evil.example.com');
    await expect(p3).rejects.toThrow(/unexpected tunnel URL/);
    expect(evil.emitter.stopped).toBe(1);
  });

  it('exited resolves when the process dies after startup, but not on stop()', async () => {
    const f = fakeCf({ binExists: true });
    const p = realTunnelStarter({ load: async () => f.mod })('http://127.0.0.1:9');
    await new Promise((r) => setTimeout(r, 10));
    f.emitter.emit('url', 'https://abc.trycloudflare.com');
    const h = await p;
    let done = false;
    void h.exited.then(() => { done = true; });
    f.emitter.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(true);
  });
});
