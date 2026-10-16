import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startHub, type RunningHub } from '@agentteams/hub';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadCredentials, type Credential } from '../src/credentials.js';
import { realExec, type CliDeps, type Exec } from '../src/deps.js';
import { runPreCommit } from '../src/gitHooks.js';
import { runHook } from '../src/hooks.js';
import { createLocalMcpServer } from '../src/local/mcp.js';
import { teamDbPath } from '../src/local/store.js';
import { main } from '../src/main.js';
import { makeTestCli, type TestCli } from './helpers.js';
import { git, makeRepo, type TempRepo } from './localHelpers.js';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const CODE_RE = /^Invite code: (\S+) \(expires \d{4}-\d{2}-\d{2}\)$/;
const noNetwork = (() => { throw new Error('no network on the local transport'); }) as unknown as typeof fetch;

/** Real git; every other tool (claude mcp add, gh) answers success without running. */
const exec: Exec = async (cmd, args, opts) => (cmd === 'git' ? realExec(cmd, args, opts) : { code: 0, stdout: '', stderr: '' });

interface Cli extends TestCli { run: (...args: string[]) => Promise<number> }

function cli(repo: string, home: TestCli | null = null, over: Partial<CliDeps> = {}): Cli {
  const t = makeTestCli({ exec, fetch: noNetwork, ...over });
  // Share one AGENTTEAMS home (one person, several agents) when asked.
  const deps: CliDeps = { ...t.deps, cwd: repo, ...(home ? { homedir: home.deps.homedir } : {}) };
  const out: string[] = [];
  const err: string[] = [];
  deps.out = (l) => out.push(l);
  deps.err = (l) => err.push(l);
  return { ...t, deps, out, err, run: (...args) => main(['node', 'agentteams', ...args], deps) };
}

const inviteOf = (c: Cli): string => CODE_RE.exec(c.out.find((l) => l.startsWith('Invite code:')) ?? '')![1]!;
const credOf = async (c: Cli, tool: string): Promise<Credential> => (await loadCredentials(c.deps)).find((x) => x.tool === tool)!;

async function mcpAs(c: Cli, cred: Credential): Promise<Client> {
  const server = await createLocalMcpServer(c.deps, cred);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}

const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0]!.text);

describe('local team: create, join, status, MCP, hooks (no hub, no network)', () => {
  let r: TempRepo;
  let a: Cli;
  let b: Cli;
  const clients: Client[] = [];
  beforeAll(async () => {
    r = makeRepo();
    a = cli(r.repo);
    b = cli(r.repo, a);
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    a.cleanup(); b.cleanup(); r.cleanup();
  });

  it('create with no flags makes a local team and saves a local credential', async () => {
    expect(await a.run('create', 'acme', '--as', 'alice')).toBe(0);
    expect(a.out[0]).toBe('Created team "acme". You are alice-claude (orchestrator).');
    expect(a.out[1]).toMatch(CODE_RE);
    expect(a.out[2]).toBe(`Teammates join with: agentteams join ${inviteOf(a)}`);
    expect(a.out).toContain('Team: local to this computer (stored in .git/agentteams)');
    expect(a.out.join('\n')).not.toMatch(/Hub:|git remote/);
    expect(a.err.join('\n')).not.toMatch(/no GitHub origin/);
    const cred = await credOf(a, 'claude');
    expect(cred).toMatchObject({ transport: 'local', hubUrl: '', agentName: 'alice-claude', teamName: 'acme' });
    expect(existsSync(await teamDbPath({ exec: realExec }, r.repo))).toBe(true);
    expect(existsSync(join(r.repo, 'CLAUDE.md'))).toBe(true);
  });

  it('a second agent joins with the code, locally', async () => {
    expect(await b.run('join', inviteOf(a), '--agent', 'codex', '--as', 'bob')).toBe(0);
    expect(b.out[0]).toBe(`Joined team "acme" as bob-codex (local). Repo: ${r.repo}`);
    expect(b.out).toContain('Team: local to this computer (stored in .git/agentteams)');
    expect(await credOf(b, 'codex')).toMatchObject({ transport: 'local', hubUrl: '', agentName: 'bob-codex' });
  });

  it('status shows both agents', async () => {
    const c = cli(r.repo, a);
    expect(await c.run('status', '--agent', 'codex')).toBe(0);
    const text = c.out.join('\n');
    expect(text).toContain('alice-claude');
    expect(text).toContain('bob-codex');
    c.cleanup();
  });

  it('in-process MCP: alice sends, bob reads his inbox', async () => {
    const alice = await mcpAs(a, await credOf(a, 'claude'));
    const bob = await mcpAs(b, await credOf(b, 'codex'));
    clients.push(alice, bob);
    expect((await alice.listTools()).tools.map((t) => t.name)).toContain('send_message');
    const sent = await alice.callTool({ name: 'send_message', arguments: { to: 'bob-codex', body: 'hello from alice' } });
    expect(sent.isError).toBeFalsy();
    const inbox = await bob.callTool({ name: 'read_inbox', arguments: {} });
    expect(textOf(inbox)).toContain('hello from alice');
    expect(textOf(inbox)).toContain('alice-claude');
  });

  it('the stop hook blocks bob for a pending orchestrator command', async () => {
    const alice = clients[0]!;
    await alice.callTool({ name: 'send_message', arguments: { to: 'bob-codex', body: 'please run the tests', kind: 'command' } });
    const res = await runHook('stop', JSON.stringify({ cwd: r.repo }), 'codex', b.deps);
    const out = JSON.parse(res.stdout) as { decision: string; reason: string };
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('please run the tests');
  });

  it('the git pre-commit guard sees claims made through local MCP', async () => {
    const bob = clients[1]!;
    const claimed = await bob.callTool({ name: 'claim_files', arguments: { globs: ['a.txt'] } });
    expect(claimed.isError).toBeFalsy();
    writeFileSync(join(r.repo, 'a.txt'), 'changed');
    git(r.repo, 'add', 'a.txt');
    const err: string[] = [];
    const code = await runPreCommit({ ...a.deps, err: (l) => err.push(l) }); // alice (claude) is picked first
    expect(code).not.toBe(0);
    expect(err.join('\n')).toMatch(/claimed by bob-codex/);
  });

  it('an unknown transport in credentials.json is rejected with a clear message', async () => {
    const c = cli(r.repo);
    mkdirSync(join(c.deps.homedir, '.agentteams'), { recursive: true });
    writeFileSync(join(c.deps.homedir, '.agentteams', 'credentials.json'), JSON.stringify({
      version: 1, credentials: [{ ...(await credOf(a, 'claude')), transport: 'carrier-pigeon' }],
    }));
    await expect(loadCredentials(c.deps)).rejects.toThrow(/unknown transport "carrier-pigeon"/);
    c.cleanup();
  });
});

describe('local create/join edge cases', () => {
  let r: TempRepo;
  const made: Cli[] = [];
  const mk = (repo: string, home: Cli | null = null, over: Partial<CliDeps> = {}) => { const c = cli(repo, home, over); made.push(c); return c; };
  beforeEach(() => { r = makeRepo(); });
  afterEach(() => { made.splice(0).forEach((c) => c.cleanup()); r.cleanup(); });

  it('a repo with a git remote still gets a local team, with a note about git sync', async () => {
    git(r.repo, 'remote', 'add', 'origin', 'https://example.com/me/app.git');
    const c = mk(r.repo);
    expect(await c.run('create', 'acme', '--no-install')).toBe(0);
    expect((await credOf(c, 'claude')).transport).toBe('local');
    expect(c.out.filter((l) => /git sync/.test(l))).toHaveLength(1);
  });

  it('refuses a local team outside a git repo, pointing at git init', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentteams-nogit-')));
    try {
      const c = mk(dir);
      expect(await c.run('create', 'acme', '--no-install')).toBe(1);
      expect(c.err.join('\n')).toMatch(/git init/);
      expect(await loadCredentials(c.deps)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a revoked local invite code is reported, not sent to a hub', async () => {
    const c = mk(r.repo);
    expect(await c.run('create', 'acme', '--no-install')).toBe(0);
    const code = inviteOf(c);
    expect(await c.run('invite', 'revoke')).toBe(0);
    const j = mk(r.repo, c);
    expect(await j.run('join', code, '--agent', 'codex', '--no-install')).toBe(1);
    expect(j.err.join('\n')).toMatch(/expired or been revoked/);
  });

  it('a linked worktree shares the team: join from it uses the same database', async () => {
    const c = mk(r.repo);
    expect(await c.run('create', 'acme', '--no-install')).toBe(0);
    const wt = join(r.root, 'wt');
    git(r.repo, 'worktree', 'add', '-q', wt, '-b', 'feature');
    const j = mk(wt, c);
    expect(await j.run('join', inviteOf(c), '--agent', 'codex', '--as', 'bob', '--no-install')).toBe(0);
    expect(j.out[0]).toMatch(/^Joined team "acme" as bob-codex \(local\)/);
  });

  describe('codes this repo does not know go to the hub as before', () => {
    let hub: RunningHub;
    let dbDir: string;
    beforeAll(async () => {
      dbDir = mkdtempSync(join(tmpdir(), 'agentteams-localfallback-'));
      hub = await startHub({ dbPath: join(dbDir, 'hub.db'), port: 0 });
    });
    afterAll(async () => { await hub.close(); rmSync(dbDir, { recursive: true, force: true }); });

    it('falls back to the hub (AGENTTEAMS_HUB) when the local database does not know the code', async () => {
      const owner = mk(r.repo);
      expect(await owner.run('create', 'acme', '--no-install')).toBe(0);
      const hubOwner = mk(r.repo, null, { fetch: globalThis.fetch });
      expect(await hubOwner.run('create', 'remote', '--hub', hub.url, '--local', '--no-install')).toBe(0);
      const hubCode = inviteOf(hubOwner);
      const j = mk(r.repo, null, { fetch: globalThis.fetch, env: { AGENTTEAMS_HUB: hub.url } });
      expect(await j.run('join', hubCode, '--agent', 'codex', '--as', 'carol', '--no-install')).toBe(0);
      expect(j.out[0]).not.toContain('(local)');
      expect(await credOf(j, 'codex')).toMatchObject({ hubUrl: hub.url, teamName: 'remote' });
      expect((await credOf(j, 'codex')).transport).toBeUndefined();
    });

    it('create --hub keeps the HTTP flow even in a repo with a local team', async () => {
      const c = mk(r.repo, null, { fetch: globalThis.fetch });
      expect(await c.run('create', 'acme', '--hub', hub.url, '--no-install')).toBe(0);
      expect(c.out.some((l) => l.startsWith('Hub: '))).toBe(true);
      expect((await credOf(c, 'claude')).transport).toBeUndefined();
    });
  });
});

describe.skipIf(!existsSync(BIN))('agentteams mcp (built binary) with a local credential', () => {
  let r: TempRepo;
  let a: Cli;
  beforeAll(() => { r = makeRepo(); a = cli(r.repo); });
  afterAll(() => { a.cleanup(); r.cleanup(); });

  it('serves the team tools in-process over stdio and exits when stdin ends', async () => {
    expect(await a.run('create', 'acme', '--as', 'alice', '--no-install')).toBe(0);
    const env = { ...process.env, HOME: a.deps.homedir, AGENTTEAMS_HOME: join(a.deps.homedir, '.agentteams'), AGENTTEAMS_HUB: '' };
    const child = spawn(process.execPath, [BIN, 'mcp', '--tool', 'claude', '--repo', r.repo], { cwd: r.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
        await new Promise((res) => setTimeout(res, 100));
      }
      throw new Error(`no response for id ${id}`);
    };
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
      await waitFor(1);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'team_status', arguments: {} } });
      const res = (await waitFor(2)).result as { content: { text: string }[]; isError?: boolean };
      expect(res.isError).toBeFalsy();
      expect(res.content[0]!.text).toContain('alice-claude');
      child.stdin.end();
      for (let i = 0; i < 50 && exited === undefined; i++) await new Promise((res) => setTimeout(res, 100));
      expect(exited).toBe(0);
    } finally {
      child.kill();
    }
  }, 30_000);
});
