import { spawn } from 'node:child_process';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveCredential } from '../../src/credentials.js';
import { realExec, type CliDeps } from '../../src/deps.js';
import { GIT_READ_ONLY_TOOLS, GIT_WRITE_TOOLS, createGitMcpServer } from '../../src/git/mcp.js';
import { listPending } from '../../src/git/replicaStore.js';
import { syncRound } from '../../src/git/sync.js';
import { spawnDetachedSync, syncPaths, writeStatus } from '../../src/git/syncState.js';
import { runHook } from '../../src/hooks.js';
import { main } from '../../src/main.js';
import { makeTestCli, type TestCli } from '../helpers.js';
import { bootstrap, deps, makeWorld, view, type Agent, type World } from './syncHelpers.js';

let world: World;
let t: TestCli;
beforeEach(() => {
  world = makeWorld();
  t = makeTestCli({ exec: realExec });
});
afterEach(async () => {
  t.cleanup();
  await world.cleanup();
});

const cliDeps = (cwd: string): CliDeps => ({ ...t.deps, cwd });
const NON_ROUTABLE = 'https://10.255.255.1/team.git';

async function saved(a: Agent): Promise<Agent> {
  await saveCredential(t.deps, a.cred);
  return a;
}

describe('git transport hooks', () => {
  it('a hook never waits on the network, even with an unreachable remote', async () => {
    const a = await saved(await bootstrap(world, world.clone('a'), 'createTeam', 'ann', { remote: NON_ROUTABLE }));
    const started = Date.now();
    const res = await runHook('session-start', JSON.stringify({ cwd: a.repo }), 'claude', cliDeps(a.repo));
    const elapsed = Date.now() - started;
    expect(res.stdout).toContain('alpha');
    expect(elapsed).toBeLessThan(1500);
    // A prompt hook (write path not involved) is just as fast.
    const s2 = Date.now();
    await runHook('user-prompt-submit', JSON.stringify({ cwd: a.repo }), 'claude', cliDeps(a.repo));
    expect(Date.now() - s2).toBeLessThan(1500);
  });

  it('shows one warning line per distinct sync error', async () => {
    const a = await saved(await bootstrap(world, world.clone('a'), 'createTeam', 'ann'));
    const paths = await syncPaths(deps, a.repo);
    await writeStatus(paths, { lastFetchAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(), lastError: 'push: rejected', lastErrorAt: new Date().toISOString() });
    const first = await runHook('session-start', JSON.stringify({ cwd: a.repo }), 'claude', cliDeps(a.repo));
    // The resolved path: in a linked worktree `.git` is a file, so a fixed `.git/agentteams` would be wrong.
    expect(first.stdout).toContain(`agentteams: sync failed: push: rejected (see ${paths.log})`);
    expect(paths.log).toBe(join(a.repo, '.git', 'agentteams', 'sync.log'));
    const second = await runHook('session-start', JSON.stringify({ cwd: a.repo }), 'claude', cliDeps(a.repo));
    expect(second.stdout).not.toContain('sync failed');
    await writeStatus(paths, { lastFetchAt: new Date().toISOString(), lastError: 'fetch: timeout', lastErrorAt: new Date().toISOString() });
    const third = await runHook('session-start', JSON.stringify({ cwd: a.repo }), 'claude', cliDeps(a.repo));
    expect(third.stdout).toContain('sync failed: fetch: timeout');
  });
});

describe('detached sync spawn', () => {
  it('returns immediately and runs the entry with sync arguments', async () => {
    const out = join(world.tmp, 'args.json');
    const script = join(world.tmp, 'fake-cli.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';\nsetTimeout(() => writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2))), 300);\n`);
    const started = Date.now();
    spawnDetachedSync(world.tmp, 'codex', script, { ...process.env, AGENTTEAMS_NO_BACKGROUND_SYNC: undefined });
    expect(Date.now() - started).toBeLessThan(200);
    expect(existsSync(out)).toBe(false);
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(['sync', '--repo', world.tmp, '--tool', 'codex', '--quiet']);
  });

  it('spawns nothing when AGENTTEAMS_NO_BACKGROUND_SYNC=1 (the test suite sets it for every test)', async () => {
    expect(process.env.AGENTTEAMS_NO_BACKGROUND_SYNC).toBe('1');
    const out = join(world.tmp, 'ran');
    const script = join(world.tmp, 'fake-cli.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, '1');\n`);
    spawnDetachedSync(world.tmp, 'codex', script);
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(out)).toBe(false);
  });
});

describe('agentteams sync / status', () => {
  it('runs one round, prints a summary, and status shows when it last synced', async () => {
    const a = await saved(await bootstrap(world, world.clone('a'), 'createTeam', 'ann'));
    const code = await main(['node', 'agentteams', 'sync', '--repo', a.repo, '--tool', 'claude'], cliDeps(a.repo));
    expect(t.err).toEqual([]);
    expect(code).toBe(0);
    expect(t.out.join('\n')).toMatch(/^agentteams: synced \(fetched, 0 ops received, 0 sent, pushed\)$/m);
    t.out.length = 0;
    expect(await main(['node', 'agentteams', 'status'], cliDeps(a.repo))).toBe(0);
    expect(t.out.join('\n')).toMatch(/Sync: last synced \d+s ago/);
    t.out.length = 0;
    expect(await main(['node', 'agentteams', 'sync', '--repo', a.repo, '--quiet'], cliDeps(a.repo))).toBe(0);
    expect(t.out).toEqual([]);
  });

  it('exits 1 and reports the error when the remote is unreachable', async () => {
    const a = await saved(await bootstrap(world, world.clone('a'), 'createTeam', 'ann', { remote: join(world.tmp, 'nope.git') }));
    expect(await main(['node', 'agentteams', 'sync'], cliDeps(a.repo))).toBe(1);
    expect(t.out.join('\n')).toMatch(/sync failed: fetch \(from git\): /);
  });
});

describe('git MCP server', () => {
  it('routes writes through op capture and reads from the view', async () => {
    const lead = await bootstrap(world, world.clone('a'), 'createTeam', 'ann');
    await syncRound(deps, lead.repo, lead.cred);
    const worker = await bootstrap(world, world.clone('b'), 'join', 'bob');
    await syncRound(deps, worker.repo, worker.cred);
    await syncRound(deps, lead.repo, lead.cred);

    const triggers: number[] = [];
    const connect = async (a: Agent) => {
      const server = await createGitMcpServer(deps, a.cred, { trigger: () => triggers.push(1) });
      const [s, c] = InMemoryTransport.createLinkedPair();
      await server.connect(s);
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(c);
      return client;
    };
    const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!.text);

    const lc = await connect(lead);
    const sent = await lc.callTool({ name: 'send_message', arguments: { to: worker.name, kind: 'command', body: 'do it' } });
    expect(sent.isError).toBeFalsy();
    expect(triggers.length).toBe(1);
    expect((await listPending((await view(lead)).store.ctx.db)).map((o) => o.op)).toEqual(['sendMessage']);
    const created = await lc.callTool({ name: 'create_task', arguments: { title: 'T1', assignee: worker.name } });
    expect(JSON.parse(text(created)).number).toBe(1);

    await syncRound(deps, lead.repo, lead.cred);
    await syncRound(deps, worker.repo, worker.cred);
    const wc = await connect(worker);
    const inbox = JSON.parse(text(await wc.callTool({ name: 'read_inbox', arguments: {} }))) as Array<{ body: string }>;
    expect(inbox.map((m) => m.body)).toContain('do it');
    expect(JSON.parse(text(await wc.callTool({ name: 'read_inbox', arguments: {} })))).toEqual([]);
    expect((await listPending((await view(worker)).store.ctx.db)).map((o) => o.op)).toContain('markRead');
    const denied = await wc.callTool({ name: 'create_task', arguments: { title: 'nope' } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/^forbidden: /);
    const tasks = JSON.parse(text(await wc.callTool({ name: 'list_tasks', arguments: {} }))) as Array<{ title: string }>;
    expect(tasks.map((x) => x.title)).toEqual(['T1']);
    await lc.close();
    await wc.close();
  });
});

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const BIN = join(DIST, 'bin.js');
const built = existsSync(BIN) && existsSync(join(DIST, 'git', 'syncState.js'));

function run(cmd: string, args: string[], input: string): Promise<{ code: number | null; stdout: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

describe('built CLI', () => {
  it.skipIf(!built)('a hook of the BUILT CLI with a non-routable remote answers well within its 2 s budget (needs pnpm -r build; skipped otherwise)', async () => {
    const a = await bootstrap(world, world.clone('a'), 'createTeam', 'ann', { remote: NON_ROUTABLE });
    await saveCredential({ env: process.env, homedir: process.env.HOME! }, a.cred);
    const r = await run(process.execPath, [BIN, 'hook', 'session-start', '--tool', 'claude'], JSON.stringify({ cwd: a.repo }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('alpha');
    expect(r.ms).toBeLessThan(2000);
  });

  it.skipIf(!built)('three processes racing for a stale lock run strictly one at a time (needs pnpm -r build; skipped otherwise)', async () => {
    const lock = join(world.tmp, 'race', 'sync.lock');
    const log = join(world.tmp, 'race.log');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(world.tmp, 'race'));
    writeFileSync(lock, '{"pid":1,"token":"stale"}\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const script = join(world.tmp, 'racer.mjs');
    writeFileSync(script, [
      `import { appendFileSync } from 'node:fs';`,
      `const { acquireLock } = await import(${JSON.stringify(pathToFileURL(join(DIST, 'git', 'syncState.js')).href)});`,
      `const l = await acquireLock(${JSON.stringify(lock)}, { waitMs: 20000, pollMs: 10 });`,
      `if (!l) process.exit(3);`,
      `appendFileSync(${JSON.stringify(log)}, 'start ' + process.pid + '\\n');`,
      `await new Promise((r) => setTimeout(r, 300));`,
      `await l.assertOwned();`,
      `appendFileSync(${JSON.stringify(log)}, 'end ' + process.pid + '\\n');`,
      `await l.release();`,
    ].join('\n'));
    const results = await Promise.all([0, 1, 2].map(() => run(process.execPath, [script], '')));
    expect(results.map((r) => r.code)).toEqual([0, 0, 0]);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(6);
    for (let i = 0; i < 6; i += 2) {
      expect(lines[i]!.startsWith('start ')).toBe(true);
      expect(lines[i + 1]).toBe(lines[i]!.replace('start', 'end'));
    }
    expect(existsSync(lock)).toBe(false);
  });
});

describe('git MCP tool surface', () => {
  it('every hub tool is either read-only or overridden for git credentials', async () => {
    const { listToolDefinitions } = await import('@agentteams/hub');
    const names = (await listToolDefinitions()).map((t) => t.name).sort();
    const covered = [...GIT_READ_ONLY_TOOLS, ...Object.keys(GIT_WRITE_TOOLS)].sort();
    expect(names).toEqual(covered);
  });
});
