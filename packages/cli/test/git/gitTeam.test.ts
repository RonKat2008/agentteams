/**
 * Git teams end to end through the CLI: create on clone A, join from B (a cwd clone, a fresh clone, --no-clone),
 * an orchestrator command and file claims crossing clones after one sync round, invites, rollback on a failed push.
 * Real git, a bare remote in a temp dir as "the GitHub repo", temp HOME and GIT_CONFIG_GLOBAL, no network.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials, type Credential } from '../../src/credentials.js';
import { realExec, type CliDeps, type Exec } from '../../src/deps.js';
import { newAgentKeyPair } from '../../src/git/crypto.js';
import { decodeInvite, encodeInvite } from '../../src/git/invite.js';
import { createGitMcpServer } from '../../src/git/mcp.js';
import { inviteUrlOf } from '../../src/git/setup.js';
import { normalizeRemote, stripCredentials } from '../../src/git/remoteUrl.js';
import { runPreCommit } from '../../src/gitHooks.js';
import { runHook } from '../../src/hooks.js';
import { openTeamStore } from '../../src/local/store.js';
import { main } from '../../src/main.js';
import { makeTestCli, type TestCli } from '../helpers.js';
import { git, makeWorld, type World } from './syncHelpers.js';

const noNetwork = (() => { throw new Error('no network for git teams'); }) as unknown as typeof fetch;
/** Real git; every other tool (claude mcp add, gh) answers success without running. */
const exec: Exec = async (cmd, args, opts) => (cmd === 'git' ? realExec(cmd, args, opts) : { code: 0, stdout: '', stderr: '' });
const CODE_RE = /^Teammates join with: agentteams join (at1-[a-z2-7]+)$/;
const WARNING = 'Treat this code like a password: it lets someone read and join the team, together with access to the repo.';

interface Cli extends TestCli { run: (...args: string[]) => Promise<number> }

// Each case runs several real git round trips.
vi.setConfig({ testTimeout: 60_000 });

let world: World;
const made: Cli[] = [];
beforeEach(() => { world = makeWorld(); });
afterEach(async () => {
  made.splice(0).forEach((c) => c.cleanup());
  await world.cleanup();
});

/** One person (own HOME) working in `cwd`. */
function cli(cwd: string, home: Cli | null = null): Cli {
  const t = makeTestCli({ exec, fetch: noNetwork });
  const deps: CliDeps = { ...t.deps, cwd, ...(home ? { homedir: home.deps.homedir } : {}) };
  const out: string[] = [];
  const err: string[] = [];
  deps.out = (l) => out.push(l);
  deps.err = (l) => err.push(l);
  const c = { ...t, deps, out, err, run: (...args: string[]) => main(['node', 'agentteams', ...args], deps) };
  made.push(c);
  return c;
}

/** Clone A with one commit pushed to the bare remote. */
function seededClone(name: string): string {
  const dir = world.clone(name);
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'push', '-q', 'origin', 'main');
  return dir;
}

const codeOf = (c: Cli): string => CODE_RE.exec(c.out.find((l) => CODE_RE.test(l)) ?? '')![1]!;
const credOf = async (c: Cli, tool = 'claude'): Promise<Credential> => (await loadCredentials(c.deps)).find((x) => x.tool === tool)!;

async function createTeam(): Promise<{ a: Cli; repoA: string; code: string }> {
  const repoA = seededClone('a');
  const a = cli(repoA);
  expect(await a.run('create', 'acme', '--as', 'alice', '--no-install')).toBe(0);
  return { a, repoA, code: codeOf(a) };
}

async function mcp(c: Cli, cred: Credential): Promise<Client> {
  const server = await createGitMcpServer(c.deps, cred, { trigger: () => {} });
  const [s, cl] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(cl);
  return client;
}

describe('git team: create and join', () => {
  it('create in a clone with a remote makes a git team, pushes it and prints the invite once', async () => {
    const { a, repoA, code } = await createTeam();
    expect(a.out[0]).toBe(`Created team "acme" (shared through ${world.remote}). You are alice-claude (orchestrator).`);
    expect(a.out[1]).toBe(`Teammates join with: agentteams join ${code}`);
    expect(a.out[2]).toBe(WARNING);
    const cred = await credOf(a);
    expect(cred).toMatchObject({ transport: 'git', teamName: 'acme', agentName: 'alice-claude', hubUrl: '', apiKey: '' });
    expect(cred.git).toMatchObject({ remote: 'origin', agentId: expect.stringMatching(/^[0-9A-Z]{26}$/) });
    // Keys appear only inside the invite (base32), never printed as such.
    const printed = [...a.out, ...a.err].join('\n');
    for (const secret of [cred.git!.privateKey, cred.git!.teamKey]) expect(printed).not.toContain(secret);
    const invite = decodeInvite(code);
    expect(invite).toMatchObject({ remote: world.remote, teamId: cred.git!.teamId, key: cred.git!.teamKey });
    expect(invite.creator).toEqual({ agentId: cred.git!.agentId, publicKey: cred.git!.publicKey });
    const refs = git(world.remote, 'for-each-ref', '--format=%(refname)', 'refs/agentteams/');
    expect(refs).toContain(`refs/agentteams/${cred.git!.teamId}/meta`);
    expect(refs).toContain(`refs/agentteams/${cred.git!.teamId}/agents/${cred.git!.agentId}`);
    expect(existsSync(join(repoA, '.git', 'agentteams', 'team.db'))).toBe(true);
  });

  it('B joins from inside its own clone (no clone made); A sees B after a sync', async () => {
    const { a, code } = await createTeam();
    const repoB = world.clone('b');
    const b = cli(repoB);
    expect(await b.run('join', code, '--agent', 'codex', '--as', 'bob', '--no-install')).toBe(0);
    expect(b.out).toEqual([`Joined team "acme" as bob-codex (shared through ${world.remote}). Repo: ${repoB}`]);
    expect(await credOf(b, 'codex')).toMatchObject({ transport: 'git', agentName: 'bob-codex', git: { remote: 'origin' } });
    expect(await a.run('sync')).toBe(0);
    a.out.length = 0;
    expect(await a.run('status')).toBe(0);
    expect(a.out.join('\n')).toMatch(/bob-codex/);
  });

  it('B joins from a directory outside any repo: a fresh clone into ./<repo name>, or into --dir', async () => {
    const { code } = await createTeam();
    const parent = join(world.tmp, 'work');
    mkdirSync(parent);
    const b = cli(parent);
    expect(await b.run('join', code, '--agent', 'codex', '--as', 'bob', '--no-install')).toBe(0);
    expect(b.out[0]).toBe(`Cloning ${world.remote} into ${join(parent, 'remote')} (use --no-clone to use this directory instead)`);
    expect(existsSync(join(parent, 'remote', 'a.txt'))).toBe(true);
    expect((await credOf(b, 'codex')).repoPath).toBe(join(parent, 'remote'));

    const c = cli(parent);
    expect(await c.run('join', code, '--agent', 'gemini', '--as', 'carol', '--dir', 'elsewhere', '--no-install')).toBe(0);
    expect((await credOf(c, 'gemini')).repoPath).toBe(join(parent, 'elsewhere'));
    // Re-running into an existing clone of the team repo reuses it.
    const d = cli(parent);
    expect(await d.run('join', code, '--agent', 'cursor', '--as', 'dan', '--dir', 'elsewhere', '--no-install')).toBe(0);
    expect(d.out.some((l) => l.startsWith('Cloning'))).toBe(false);
  });

  it('--no-clone joins in the current repo and syncs with the invite URL directly', async () => {
    const { code } = await createTeam();
    const plain = join(world.tmp, 'plain');
    git(undefined, 'init', '-q', plain);
    const b = cli(plain);
    expect(await b.run('join', code, '--agent', 'codex', '--as', 'bob', '--no-clone', '--no-install')).toBe(0);
    expect(b.err.join('\n')).toContain(`this repo has no remote for ${world.remote}`);
    expect((await credOf(b, 'codex')).git!.remote).toBe(world.remote);
  });

  it('a second agent in the same clone joins with the same code under its own name', async () => {
    const { a, repoA, code } = await createTeam();
    const a2 = cli(repoA, a);
    expect(await a2.run('join', code, '--agent', 'codex', '--as', 'alice', '--no-install')).toBe(0);
    expect(a2.out[0]).toMatch(/^Joined team "acme" as alice-codex /);
  });
});

describe('git team: work crosses clones after one sync round', () => {
  it('an orchestrator command reaches B, and B\'s claims block A\'s commit', async () => {
    const { a, repoA, code } = await createTeam();
    const repoB = world.clone('b');
    const b = cli(repoB);
    expect(await b.run('join', code, '--agent', 'codex', '--as', 'bob', '--no-install')).toBe(0);
    expect(await a.run('sync')).toBe(0);

    const alice = await mcp(a, await credOf(a));
    const sent = await alice.callTool({ name: 'send_message', arguments: { to: 'bob-codex', kind: 'command', body: 'please run the tests' } });
    expect(sent.isError).toBeFalsy();
    expect(await a.run('sync')).toBe(0);
    expect(await b.run('sync')).toBe(0);
    const stop = await runHook('stop', JSON.stringify({ cwd: repoB }), 'codex', b.deps);
    const decision = JSON.parse(stop.stdout) as { decision: string; reason: string };
    expect(decision.decision).toBe('block');
    expect(decision.reason).toContain('please run the tests');

    const bob = await mcp(b, await credOf(b, 'codex'));
    expect((await bob.callTool({ name: 'claim_files', arguments: { globs: ['a.txt'] } })).isError).toBeFalsy();
    expect(await b.run('sync')).toBe(0);
    expect(await a.run('sync')).toBe(0);
    writeFileSync(join(repoA, 'a.txt'), 'changed');
    git(repoA, 'add', 'a.txt');
    const err: string[] = [];
    expect(await runPreCommit({ ...a.deps, err: (l) => err.push(l) })).not.toBe(0);
    expect(err.join('\n')).toMatch(/claimed by bob-codex/);
    await alice.close();
    await bob.close();
  });
});

describe('git team: invites and failures', () => {
  it('invite show prints the same code again; rotate and revoke explain the repo-access model', async () => {
    const { a, code } = await createTeam();
    a.out.length = 0;
    expect(await a.run('invite', 'show')).toBe(0);
    expect(a.out).toEqual([`Team "acme" (shared through ${world.remote})`, `Teammates join with: agentteams join ${code}`, WARNING]);
    for (const action of ['rotate', 'revoke']) {
      expect(await a.run('invite', action)).toBe(1);
      expect(a.err.at(-1)).toMatch(new RegExp(`cannot ${action} the invite: .*access to the repo.*new team`));
    }
  });

  it('the invite URL has credentials embedded in the remote URL stripped', async () => {
    const repo = world.clone('cred');
    git(repo, 'remote', 'set-url', 'origin', 'https://x-access-token:s3cret@example.invalid/me/app.git');
    expect(await inviteUrlOf({ exec: realExec }, repo, 'origin')).toBe('https://example.invalid/me/app.git');
    expect(stripCredentials('ssh://git:pw@example.com/me/app.git')).toBe('ssh://git@example.com/me/app.git');
    expect(stripCredentials('https://token@github.com/me/app.git')).toBe('https://github.com/me/app.git');
    expect(stripCredentials('git@github.com:me/app.git')).toBe('git@github.com:me/app.git');
    expect(await normalizeRemote('git@GitHub.com:me/app.git')).toBe(await normalizeRemote('https://u:p@github.com/me/app/'));
  });

  it('a failed push reports push access and rolls back; a retry then works', async () => {
    const repoA = seededClone('a');
    const a = cli(repoA);
    chmodSync(join(world.remote, 'refs'), 0o555);
    chmodSync(join(world.remote, 'objects'), 0o555);
    try {
      expect(await a.run('create', 'acme', '--as', 'alice', '--no-install')).toBe(1);
    } finally {
      chmodSync(join(world.remote, 'refs'), 0o755);
      chmodSync(join(world.remote, 'objects'), 0o755);
    }
    expect(a.err.join('\n')).toContain(`push access to ${world.remote} is required`);
    expect(await loadCredentials(a.deps)).toEqual([]);
    expect(git(repoA, 'for-each-ref', 'refs/agentteams-local/')).toBe('');
    const { ctx } = await openTeamStore({ exec: realExec }, repoA);
    expect(await ctx.db.selectFrom('teams').selectAll().execute()).toEqual([]);
    expect(await a.run('create', 'acme', '--as', 'alice', '--no-install')).toBe(0);
  });

  it('a join whose push fails is undone, so a retry keeps the name', async () => {
    const { code } = await createTeam();
    const b = cli(world.clone('b'));
    chmodSync(join(world.remote, 'refs'), 0o555);
    chmodSync(join(world.remote, 'objects'), 0o555);
    try {
      expect(await b.run('join', code, '--agent', 'codex', '--as', 'bob', '--no-install')).toBe(1);
    } finally {
      chmodSync(join(world.remote, 'refs'), 0o755);
      chmodSync(join(world.remote, 'objects'), 0o755);
    }
    expect(b.err.join('\n')).toContain('push access');
    expect(await loadCredentials(b.deps)).toEqual([]);
    expect(await b.run('join', code, '--agent', 'codex', '--as', 'bob', '--no-install')).toBe(0);
    expect(b.out.at(-1)).toMatch(/as bob-codex /);
  });

  it('an invite whose creator does not match the shared team data is refused', async () => {
    const { code } = await createTeam();
    const forged = encodeInvite({ ...decodeInvite(code), creator: { ...decodeInvite(code).creator, publicKey: newAgentKeyPair().publicKey } });
    const b = cli(world.clone('b'));
    expect(await b.run('join', forged, '--agent', 'codex', '--as', 'bob', '--no-install')).toBe(1);
    expect(b.err.join('\n')).toContain('does not match this invite code');
    expect(await loadCredentials(b.deps)).toEqual([]);
  });

  it('a code that is neither at1- nor this repo\'s own, without --hub, explains the three kinds of codes', async () => {
    const b = cli(world.clone('b'));
    expect(await b.run('join', 'abcd-efgh-jkmn-pqrs', '--no-install')).toBe(1);
    const text = b.err.join('\n');
    expect(text).toContain('three kinds of codes');
    expect(text).toContain('at1-');
    expect(text).toContain('--hub <url>');
  });

  it('--this-computer in a clone with a remote makes a local team (nothing pushed)', async () => {
    const repoA = seededClone('a');
    const a = cli(repoA);
    expect(await a.run('create', 'acme', '--this-computer', '--no-install')).toBe(0);
    expect((await credOf(a)).transport).toBe('local');
    expect(git(world.remote, 'for-each-ref', 'refs/agentteams/')).toBe('');
    // ...and a git create is then refused rather than mixing two teams in one database.
    const a2 = cli(repoA, a);
    expect(await a2.run('create', 'other', '--agent', 'codex', '--no-install')).toBe(1);
    expect(a2.err.join('\n')).toContain('already has a team');
  });
});
