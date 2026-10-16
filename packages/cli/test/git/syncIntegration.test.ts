import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveCredential } from '../../src/credentials.js';
import { realExec, type CliDeps } from '../../src/deps.js';
import { createGitMcpServer } from '../../src/git/mcp.js';
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
    expect(first.stdout).toContain('agentteams: sync failed: push: rejected (see .git/agentteams/sync.log)');
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
    spawnDetachedSync(world.tmp, 'codex', script);
    expect(Date.now() - started).toBeLessThan(200);
    expect(existsSync(out)).toBe(false);
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(['sync', '--repo', world.tmp, '--tool', 'codex', '--quiet']);
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
    expect(t.out.join('\n')).toMatch(/sync failed: fetch:/);
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
    expect((await (await view(lead)).files.listPending()).map((o) => o.op)).toEqual(['sendMessage']);
    const created = await lc.callTool({ name: 'create_task', arguments: { title: 'T1', assignee: worker.name } });
    expect(JSON.parse(text(created)).number).toBe(1);

    await syncRound(deps, lead.repo, lead.cred);
    await syncRound(deps, worker.repo, worker.cred);
    const wc = await connect(worker);
    const inbox = JSON.parse(text(await wc.callTool({ name: 'read_inbox', arguments: {} }))) as Array<{ body: string }>;
    expect(inbox.map((m) => m.body)).toContain('do it');
    expect(JSON.parse(text(await wc.callTool({ name: 'read_inbox', arguments: {} })))).toEqual([]);
    expect((await (await view(worker)).files.listPending()).map((o) => o.op)).toContain('markRead');
    const denied = await wc.callTool({ name: 'create_task', arguments: { title: 'nope' } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/^forbidden: /);
    const tasks = JSON.parse(text(await wc.callTool({ name: 'list_tasks', arguments: {} }))) as Array<{ title: string }>;
    expect(tasks.map((x) => x.title)).toEqual(['T1']);
    await lc.close();
    await wc.close();
  });
});
