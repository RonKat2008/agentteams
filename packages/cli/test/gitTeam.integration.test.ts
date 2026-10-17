/**
 * Serverless git team, end to end on three "machines" (alice/claude, jamie/codex, kai/cursor).
 * Each machine is its own clone of one bare remote, with its own HOME, AGENTTEAMS_HOME and GIT_CONFIG_GLOBAL.
 * Everything goes through the command functions (`main`), the hook entry points and the in-process MCP server.
 * State is only inspected, never edited. Sync rounds are driven explicitly; no sleeps, no network.
 * The cases share state and run in order.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ToolKind } from '@agentteams/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadCredentials, type Credential } from '../src/credentials.js';
import { realExec, type CliDeps, type Exec } from '../src/deps.js';
import { createGitMcpServer } from '../src/git/mcp.js';
import { REPLICATED_TABLES } from '../src/git/replay.js';
import { openGitView } from '../src/git/view.js';
import { runPreCommit } from '../src/gitHooks.js';
import { runHook } from '../src/hooks.js';
import { main } from '../src/main.js';
import { git, makeWorld, type World } from './git/syncHelpers.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const noNetwork = (() => { throw new Error('no network for git teams'); }) as unknown as typeof fetch;
const HOOK_BUDGET_MS = 1500;
const CODE_RE = /^Teammates join with: agentteams join (at1-[a-z2-7]+)$/;

interface Machine {
  label: string;
  tool: ToolKind;
  repo: string;
  deps: CliDeps;
  out: string[];
  err: string[];
  run: (...args: string[]) => Promise<number>;
  cred: () => Promise<Credential>;
}

let world: World;
let a: Machine;
let b: Machine;
let c: Machine;
let code = '';
let teamId = '';
const clients: Client[] = [];
const hookTimings: Array<{ what: string; ms: number }> = [];

/** A machine: own HOME, AGENTTEAMS_HOME and GIT_CONFIG_GLOBAL, applied to every git call it makes. */
function machine(label: string, tool: ToolKind, cwd: string, user: string): Machine {
  const root = join(world.tmp, `machine-${label}`);
  const home = join(root, 'home');
  const atHome = join(root, 'agentteams-home');
  mkdirSync(home, { recursive: true });
  mkdirSync(atHome, { recursive: true });
  const gitConfig = join(root, 'gitconfig');
  writeFileSync(gitConfig, `[user]\n\tname = ${user}\n\temail = ${user}@example.com\n[init]\n\tdefaultBranch = main\n`);
  const env = { HOME: home, AGENTTEAMS_HOME: atHome, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
  // Real git with this machine's environment; every other tool (claude mcp add, gh) just answers success.
  const exec: Exec = async (cmd, args, opts) =>
    cmd === 'git' ? realExec(cmd, args, { ...opts, env: { ...env, ...opts?.env } }) : { code: 0, stdout: '', stderr: '' };
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    env, cwd, homedir: home, username: user, exec, fetch: noNetwork,
    out: (l) => out.push(l), err: (l) => err.push(l), write: () => {},
    readStdin: async () => '', isTTY: false, color: false, prompt: async () => '',
  };
  const m: Machine = {
    label, tool, repo: cwd, deps, out, err,
    run: (...args) => main(['node', 'agentteams', ...args], m.deps),
    cred: async () => (await loadCredentials(m.deps)).find((x) => x.tool === tool)!,
  };
  return m;
}

const setCwd = (m: Machine, cwd: string): void => { m.deps = { ...m.deps, cwd }; m.repo = cwd; };

/** The real MCP server in process, on a client; the background sync trigger is off (rounds are explicit). */
async function mcp(m: Machine): Promise<Client> {
  const server = await createGitMcpServer(m.deps, await m.cred(), { trigger: () => {} });
  const [s, cl] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: `test-${m.label}`, version: '0' });
  await client.connect(cl);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
  const text = res.content[0]?.text ?? '';
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

async function sync(m: Machine): Promise<string> {
  m.out.length = 0;
  m.err.length = 0;
  expect(await m.run('sync'), `${m.label} sync: ${m.err.join(' | ')}`).toBe(0);
  return m.out.join('\n');
}

/** Runs a hook-path call and records how long it took. */
async function timed<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try { return await fn(); } finally { hookTimings.push({ what, ms: Math.round(performance.now() - t0) }); }
}

const stopHook = (m: Machine): Promise<{ stdout: string }> =>
  timed(`${m.label} stop`, () => runHook('stop', JSON.stringify({ cwd: m.repo }), m.tool, m.deps));
const preCommit = (m: Machine): Promise<{ code: number; err: string }> =>
  timed(`${m.label} pre-commit`, async () => {
    const lines: string[] = [];
    const rc = await runPreCommit({ ...m.deps, cwd: m.repo, err: (l) => lines.push(l) });
    return { code: rc, err: lines.join('\n') };
  });

const blockText = (m: Machine, stdout: string): string => {
  const o = JSON.parse(stdout) as { decision?: string; reason?: string; followup_message?: string };
  if (m.tool === 'cursor') return o.followup_message ?? '';
  expect(o.decision).toBe('block');
  return o.reason ?? '';
};

/** Every replicated table, rows sorted; last_seen_at (presence, local by design) left out. */
async function dumpTables(m: Machine): Promise<string> {
  const { store } = await openGitView(m.deps, await m.cred());
  const out: Record<string, string[]> = {};
  for (const table of REPLICATED_TABLES) {
    const rows = await store.ctx.db.selectFrom(table).selectAll().execute();
    out[table] = rows.map((r) => {
      const { last_seen_at: _ignored, ...rest } = r as Record<string, unknown>;
      return JSON.stringify(rest);
    }).sort();
  }
  return JSON.stringify(out);
}

/** Drops presence timestamps (and the online state derived from them) at any depth. */
const stripPresence = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stripPresence);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !/^(lastSeen|last_seen|lastSeenAt|last_seen_at|presence|online|state)$/i.test(k))
      .map(([k, x]) => [k, stripPresence(x)]));
  }
  return v;
};

interface View { status: unknown; activity: unknown; tables: string }
async function viewOf(m: Machine): Promise<View> {
  const client = await mcp(m);
  return {
    status: stripPresence(await call(client, 'team_status')),
    activity: await call(client, 'get_activity', { limit: 500 }),
    tables: await dumpTables(m),
  };
}

async function converge(): Promise<void> {
  for (let round = 0; round < 2; round++) for (const m of [a, b, c]) await sync(m);
}

beforeAll(() => {
  world = makeWorld();
  const repoA = world.clone('alice');
  writeFileSync(join(repoA, 'a.txt'), 'a');
  writeFileSync(join(repoA, 'b.txt'), 'b');
  git(repoA, 'add', '.');
  git(repoA, 'commit', '-q', '-m', 'init');
  git(repoA, 'push', '-q', 'origin', 'main');
  a = machine('alice', 'claude', repoA, 'alice');
  const parentB = join(world.tmp, 'machine-jamie-work');
  mkdirSync(parentB, { recursive: true });
  b = machine('jamie', 'codex', parentB, 'jamie');
  c = machine('kai', 'cursor', world.clone('kai'), 'kai');
});

afterAll(async () => {
  await Promise.all(clients.map((cl) => cl.close().catch(() => {})));
  await world.cleanup();
});

describe('three machines, one bare remote', () => {
  it('1. alice creates the team and gets an at1- invite', async () => {
    expect(await a.run('create', 'acme', '--as', 'alice', '--no-install')).toBe(0);
    code = CODE_RE.exec(a.out.find((l) => CODE_RE.test(l)) ?? '')![1]!;
    expect(code).toMatch(/^at1-/);
    teamId = (await a.cred()).git!.teamId;
    expect((await a.cred()).agentName).toBe('alice-claude');
  });

  it('2. jamie joins by cloning from the invite; kai joins with --no-clone inside his own clone', async () => {
    expect(await b.run('join', code, '--agent', 'codex', '--as', 'jamie', '--no-install')).toBe(0);
    setCwd(b, join(b.deps.cwd, 'remote'));
    expect(b.out[0]).toContain('Cloning');
    expect((await b.cred()).repoPath).toBe(b.repo);
    expect(await c.run('join', code, '--agent', 'cursor', '--as', 'kai', '--no-clone', '--no-install')).toBe(0);
    expect(c.out.at(-1)).toMatch(/^Joined team "acme" as kai-cursor /);
    // Separate HOME and AGENTTEAMS_HOME: credentials live under each machine's own home.
    expect((await loadCredentials(c.deps)).map((x) => x.agentName)).toEqual(['kai-cursor']);
    expect((await loadCredentials(a.deps)).map((x) => x.agentName)).toEqual(['alice-claude']);
    await sync(a);
    a.out.length = 0;
    expect(await a.run('status')).toBe(0);
    expect(a.out.join('\n')).toMatch(/jamie-codex[\s\S]*kai-cursor|kai-cursor[\s\S]*jamie-codex/);
  });

  it('3. alice, the orchestrator, creates two assigned tasks and broadcasts an fyi through MCP', async () => {
    const alice = await mcp(a);
    await call(alice, 'create_task', { title: 'Wire the login form', assignee: 'jamie-codex' });
    await call(alice, 'create_task', { title: 'Write the billing docs', assignee: 'kai-cursor' });
    await call(alice, 'send_message', { to: 'all', kind: 'fyi', body: 'standup moved to ten' });
    const tasks = await call(alice, 'list_tasks');
    expect(JSON.stringify(tasks)).toMatch(/Wire the login form[\s\S]*Write the billing docs/);
  });

  it('4. after a sync round, jamie\'s and kai\'s stop hooks block on the unread command; read_inbox shows the broadcast', async () => {
    for (const m of [a, b, c]) await sync(m);
    const jamieInbox = await call(await mcp(b), 'read_inbox', { markRead: false });
    const kaiInbox = await call(await mcp(c), 'read_inbox', { markRead: false });
    for (const inbox of [jamieInbox, kaiInbox]) expect(JSON.stringify(inbox)).toContain('standup moved to ten');
    const jamieStop = await stopHook(b);
    expect(blockText(b, jamieStop.stdout)).toContain('Wire the login form');
    const kaiStop = await stopHook(c);
    expect(blockText(c, kaiStop.stdout)).toContain('Write the billing docs');
    // The hooks consumed what they showed: the inbox is now empty.
    expect(JSON.stringify(await call(await mcp(b), 'read_inbox'))).not.toContain('Wire the login form');
  });

  it('5. jamie claims task 1 and a.txt; kai\'s commit to a.txt is blocked on C after C syncs', async () => {
    const jamie = await mcp(b);
    await call(jamie, 'claim_task', { task: 1 });
    await call(jamie, 'claim_files', { globs: ['a.txt'] });
    await sync(b);
    await sync(c);
    writeFileSync(join(c.repo, 'a.txt'), 'kai was here');
    git(c.repo, 'add', 'a.txt');
    const blocked = await preCommit(c);
    expect(blocked.code).not.toBe(0);
    expect(blocked.err).toMatch(/claimed by jamie-codex/);
    // The guard is per file: an unclaimed file passes.
    git(c.repo, 'reset', '-q', 'a.txt');
    git(c.repo, 'checkout', '--', 'a.txt');
    writeFileSync(join(c.repo, 'b.txt'), 'kai edits b');
    git(c.repo, 'add', 'b.txt');
    expect((await preCommit(c)).code).toBe(0);
    git(c.repo, 'reset', '-q', 'b.txt');
    git(c.repo, 'checkout', '--', 'b.txt');
  });

  it('6. kai goes offline and keeps working while alice and jamie keep working', async () => {
    const kai = await mcp(c);
    await call(kai, 'claim_task', { task: 2 });
    await call(kai, 'send_message', { to: 'alice-claude', kind: 'fyi', body: 'kai offline: docs underway' });
    // Alice and jamie work and sync with each other; C never syncs here.
    const alice = await mcp(a);
    const jamie = await mcp(b);
    await call(alice, 'send_message', { to: 'jamie-codex', kind: 'fyi', body: 'review ready for login' });
    await call(jamie, 'update_task', { task: 1, note: 'login form half done' });
    await call(jamie, 'complete_task', { task: 1, summary: 'login form shipped', branch: 'at/jamie-codex/1' });
    for (const m of [a, b, a]) await sync(m);
    // Kai's side still has no idea about jamie's completion.
    const kaiTasks = JSON.stringify(await call(kai, 'list_tasks'));
    expect(kaiTasks).not.toContain('login form shipped');
  });

  it('7. kai reconnects; after a final round every replica is identical', async () => {
    await sync(c);
    await converge();
    const [va, vb, vc] = [await viewOf(a), await viewOf(b), await viewOf(c)];
    // The scenario really happened on every replica.
    const text = JSON.stringify(va.activity);
    for (const needle of ['Wire the login form', 'Write the billing docs', 'standup moved to ten', 'kai offline: docs underway', 'login form shipped']) {
      expect(text, needle).toContain(needle);
    }
    expect(vb).toEqual(va);
    expect(vc).toEqual(va);
    // Session-start hooks on every machine show the same converged team.
    for (const m of [a, b, c]) {
      const start = await timed(`${m.label} session-start`, () => runHook('session-start', JSON.stringify({ cwd: m.repo }), m.tool, m.deps));
      expect(start.stdout, m.label).toContain('kai-cursor');
    }
    const board = JSON.stringify(await call(await mcp(c), 'list_tasks'));
    expect(board).toMatch(/done/);
    expect(board).toMatch(/in_progress/);
  });

  it('8. a tampered segment in jamie\'s ref is refused by A and C, then restored by jamie\'s next round', async () => {
    const jamieId = (await b.cred()).git!.agentId;
    const ref = `refs/agentteams/${teamId}/agents/${jamieId}`;
    await converge(); // publish whatever the session-start hooks marked read, so only the tamper changes the picture
    const before = { a: await dumpTables(a), c: await dumpTables(c) };
    const goodTip = git(world.remote, 'rev-parse', ref);

    // A scratch clone with plain git: put a junk blob on top of jamie's ref and push it (a fast-forward).
    const evil = world.clone('scratch');
    git(evil, 'fetch', '-q', world.remote, `+${ref}:refs/x`);
    const names = git(evil, 'ls-tree', '--name-only', 'refs/x:ops').split('\n').filter(Boolean);
    const last = names.map((n) => /^(\d+)\.bin$/.exec(n)).filter((m): m is RegExpExecArray => m !== null).map((m) => m[1]!).sort().at(-1)!;
    const next = String(Number(last) + 1).padStart(last.length, '0');
    const junk = execBlob(evil, 'this is not a segment');
    const entries = git(evil, 'ls-tree', 'refs/x').split('\n');
    const opsTree = git(evil, 'ls-tree', 'refs/x:ops').split('\n').concat(`100644 blob ${junk}\t${next}.bin`);
    const newOps = mkTree(evil, opsTree);
    const root = mkTree(evil, entries.map((l) => (l.endsWith('\tops') ? `040000 tree ${newOps}\tops` : l)));
    const evilCommit = git(evil, 'commit-tree', root, '-p', 'refs/x', '-m', 'junk');
    git(evil, 'push', '-q', world.remote, `${evilCommit}:${ref}`);
    expect(git(world.remote, 'rev-parse', ref)).toBe(evilCommit);

    for (const m of [a, c]) {
      const summary = await sync(m);
      expect(summary, `${m.label} sync summary`).toMatch(/refused/);
      const log = readFileSync(join(m.repo, '.git', 'agentteams', 'sync.log'), 'utf8');
      expect(log).toContain(jamieId);
    }
    expect(await dumpTables(a)).toBe(before.a);
    expect(await dumpTables(c)).toBe(before.c);

    // Jamie's own next round puts his real chain back on the remote.
    const summary = await sync(b);
    expect(summary).toMatch(/own log restored/);
    expect(git(world.remote, 'rev-parse', ref)).toBe(goodTip);
    await converge();
    const [va, vb, vc] = [await viewOf(a), await viewOf(b), await viewOf(c)];
    expect(vb).toEqual(va);
    expect(vc).toEqual(va);
    expect(await dumpTables(a)).toBe(before.a);
  });

  it('9. no hook invocation took longer than 1.5 s', () => {
    expect(hookTimings.length).toBeGreaterThanOrEqual(4);
    // eslint-disable-next-line no-console
    console.log(`hook timings (ms): ${hookTimings.map((t) => `${t.what}=${t.ms}`).join(', ')}`);
    for (const t of hookTimings) expect(t.ms, t.what).toBeLessThan(HOOK_BUDGET_MS);
  });
});

/** Plain git with stdin (the shared `git` helper has none). */
function gitIn(repo: string, input: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, input, encoding: 'utf8' }).trim();
}
const execBlob = (repo: string, content: string): string => gitIn(repo, content, 'hash-object', '-w', '--stdin');
const mkTree = (repo: string, lines: string[]): string => gitIn(repo, `${lines.join('\n')}\n`, 'mktree');
