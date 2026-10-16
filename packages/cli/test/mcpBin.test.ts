import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHub } from '@agentteams/hub';
import { saveCredential } from '../src/credentials.js';
import { HubClient } from '../src/hubClient.js';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const built = existsSync(BIN);
if (!built) console.warn(`mcpBin.test: ${BIN} missing; run "pnpm -r build" first (test skipped)`);

let dir: string;
let hub: Awaited<ReturnType<typeof startHub>>;
beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentteams-mcpbin-')));
  hub = await startHub({ dbPath: join(dir, 'hub.db'), port: 0 });
});
afterEach(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

async function joinRepo() {
    const repo = join(dir, 'repo');
    const home = join(dir, 'home');
    execFileSync('mkdir', ['-p', repo, home]);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const created = await new HubClient(hub.url).createTeam({ name: 's', member: 'ronit', tool: 'codex', repo: { provider: 'local' } });
    const env = { ...process.env, AGENTTEAMS_HOME: join(home, '.at') };
    await saveCredential({ env, homedir: home }, {
      repoPath: repo, tool: 'codex', hubUrl: hub.url, teamName: 's', agentName: created.agentName,
      apiKey: created.apiKey, createdAt: new Date().toISOString(),
    });
  return { repo, env };
}

describe.skipIf(!built)('agentteams mcp (built binary)', () => {
  it('stays alive and serves tools/list over stdio', async () => {
    const { repo, env } = await joinRepo();

    const child = spawn(process.execPath, [BIN, 'mcp', '--tool', 'codex'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let exited: number | null | undefined;
    child.on('exit', (c) => { exited = c; });
    const lines: string[] = [];
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const waitFor = async (id: number) => {
      for (let i = 0; i < 100; i++) {
        const hit = lines.map((l) => JSON.parse(l) as { id?: number; result?: unknown }).find((m) => m.id === id);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no response for id ${id}`);
    };
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
      await waitFor(1);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const res = (await waitFor(2)).result as { tools: Array<{ name: string }> };
      expect(res.tools.map((t) => t.name)).toContain('team_status');
      expect(exited).toBeUndefined();
      child.stdin.end();
      for (let i = 0; i < 50 && exited === undefined; i++) await new Promise((r) => setTimeout(r, 100));
      expect(exited).toBe(0);
    } finally {
      child.kill();
    }
  }, 30_000);

  it('--repo resolves credentials for that repo even when started elsewhere', async () => {
    const { repo, env } = await joinRepo();
    const toolCount = async (args: string[]): Promise<number | undefined> => {
      const child = spawn(process.execPath, [BIN, 'mcp', '--tool', 'codex', ...args], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr.on('data', () => undefined);
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
      const timer = setTimeout(() => child.kill(), 20_000);
      try {
        child.stdin.write([
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ].map((m) => `${JSON.stringify(m)}\n`).join(''));
        child.stdin.end();
        await exited;
        const msgs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id?: number; result?: { tools?: unknown[] } });
        return msgs.find((m) => m.id === 2)?.result?.tools?.length;
      } finally {
        clearTimeout(timer);
        child.kill();
      }
    };
    expect(await toolCount([])).toBe(0);
    expect(await toolCount(['--repo', repo])).toBe(15);
  }, 60_000);

  it('finishes in-flight requests when stdin ends right after they are sent', async () => {
    const { repo, env } = await joinRepo();
    const child = spawn(process.execPath, [BIN, 'mcp', '--tool', 'codex'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
      child.stdin.write([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ].map((m) => `${JSON.stringify(m)}\n`).join(''));
      child.stdin.end();
      expect(await exited).toBe(0);
      const msgs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id?: number; result?: { tools?: unknown[] } });
      expect(msgs.find((m) => m.id === 1)?.result).toBeDefined();
      expect(msgs.find((m) => m.id === 2)?.result?.tools).toHaveLength(15);
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  }, 30_000);
});
