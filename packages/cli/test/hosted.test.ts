import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type RunningHub } from '@agentteams/hub';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { resolveCredential } from '../src/credentials.js';
import { realExec, type Exec } from '../src/deps.js';
import { githubTokenFor } from '../src/commands/hostedAuth.js';
import { HubClient } from '../src/hubClient.js';
import { main } from '../src/main.js';
import { makeTestCli, type TestCli } from './helpers.js';

const TOKEN = 'gho_supersecrettoken123';
const ENV_KEYS = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const saved: Record<string, string | undefined> = {};
const run = (t: TestCli, ...args: string[]) => main(['node', 'agentteams', ...args], t.deps);

type GhMode = 'ok' | 'missing' | 'logged-out';
function ghExec(mode: GhMode, calls: string[][]): Exec {
  return async (cmd, args, opts) => {
    if (cmd === 'claude') return { code: 0, stdout: '', stderr: '' };
    if (cmd === 'gh') {
      calls.push(args);
      if (args[0] === 'auth' && args[1] === 'token') {
        if (mode === 'missing') return { code: 127, stdout: '', stderr: 'command not found: gh' };
        if (mode === 'logged-out') return { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' };
        return { code: 0, stdout: `${TOKEN}\n`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    return realExec(cmd, args, opts);
  };
}

let hosted: RunningHub;
let local: RunningHub;
let dbDir: string;
const seenTokens: string[] = [];
const clis: TestCli[] = [];
const mk = (gh: GhMode, calls: string[][] = [], fetchFn?: typeof fetch): TestCli => {
  const t = makeTestCli({ exec: ghExec(gh, calls), ...(fetchFn ? { fetch: fetchFn } : {}) });
  clis.push(t);
  return t;
};
const allOutput = (t: TestCli): string => [...t.out, ...t.err, ...t.raw].join('\n');

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'agentteams-hosted-db-'));
  hosted = await startHub({
    dbPath: join(dbDir, 'hosted.db'), port: 0, mode: 'hosted', allowedHosts: ['127.0.0.1', 'localhost'],
    verifyGithub: async (token) => { seenTokens.push(token); return { login: 'octo_cat', id: 1 }; },
  });
  local = await startHub({ dbPath: join(dbDir, 'local.db'), port: 0 });
});
afterAll(async () => {
  await hosted.close(); await local.close();
  rmSync(dbDir, { recursive: true, force: true });
  clis.forEach((c) => c.cleanup());
});
beforeEach(() => { for (const [k, v] of Object.entries(ENV_KEYS)) { saved[k] = process.env[k]; process.env[k] = v; } seenTokens.length = 0; });
afterEach(() => { for (const k of Object.keys(ENV_KEYS)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const initRepo = (t: TestCli) => realExec('git', ['init', '-q'], { cwd: t.deps.cwd });

describe('hosted create and join', () => {
  it('create sends the gh token to the hub and never prints it', async () => {
    const t = mk('ok');
    await initRepo(t);
    expect(await run(t, 'create', 'hteam', '--repo', 'me/app', '--hub', hosted.url, '--no-install')).toBe(0);
    expect(seenTokens).toEqual([TOKEN]);
    expect(allOutput(t)).not.toContain(TOKEN);
    expect(t.out.join('\n')).toContain('octo_cat');
    expect((await resolveCredential(t.deps, t.deps.cwd, 'claude'))?.agentName).toContain('octo_cat');
  });

  it('join sends the gh token once and never prints it', async () => {
    const owner = mk('ok');
    await initRepo(owner);
    await run(owner, 'create', 'jteam', '--repo', 'me/app', '--hub', hosted.url, '--no-install');
    const code = /Invite code: (\S+)/.exec(owner.out.join('\n'))![1]!;
    seenTokens.length = 0;
    const joiner = mk('ok');
    await initRepo(joiner);
    await realExec('git', ['remote', 'add', 'origin', 'https://github.com/me/app.git'], { cwd: joiner.deps.cwd });
    expect(await run(joiner, 'join', code, '--hub', hosted.url, '--no-install')).toBe(0);
    expect(seenTokens).toEqual([TOKEN]);
    expect(allOutput(joiner)).not.toContain(TOKEN);
  });

  it('does not run gh auth token against a local hub', async () => {
    const calls: string[][] = [];
    const t = mk('missing', calls);
    await initRepo(t);
    expect(await run(t, 'create', 'lteam', '--local', '--hub', local.url, '--no-install')).toBe(0);
    expect(calls.filter((a) => a[0] === 'auth')).toEqual([]);
  });

  it('errors when gh is missing, before any request that creates a team', async () => {
    const t = mk('missing');
    await initRepo(t);
    expect(await run(t, 'create', 'x1', '--repo', 'me/app', '--hub', hosted.url, '--no-install')).toBe(1);
    expect(t.err.join('\n')).toContain('this hub requires GitHub identity: install the GitHub CLI and run gh auth login');
    expect(seenTokens).toEqual([]);
  });

  it('errors when gh is not logged in', async () => {
    const t = mk('logged-out');
    await initRepo(t);
    expect(await run(t, 'create', 'x2', '--repo', 'me/app', '--hub', hosted.url, '--no-install')).toBe(1);
    expect(t.err.join('\n')).toContain('gh is not logged in; run: gh auth login');
  });

  it('get the token before creating a new repo', async () => {
    const calls: string[][] = [];
    const t = mk('logged-out', calls);
    expect(await run(t, 'create', 'newr', '--new-repo', '--hub', hosted.url)).toBe(1);
    expect(calls.map((a) => a.join(' '))).toEqual(['auth token']);
  });

  it('join gets the token before cloning', async () => {
    const owner = mk('ok');
    await initRepo(owner);
    await run(owner, 'create', 'cteam', '--repo', 'me/app', '--hub', hosted.url, '--no-install');
    const code = /Invite code: (\S+)/.exec(owner.out.join('\n'))![1]!;
    const calls: string[][] = [];
    const joiner = mk('logged-out', calls);
    expect(await run(joiner, 'join', code, '--hub', hosted.url, '--no-install')).toBe(1);
    expect(calls.map((a) => a.join(' '))).toEqual(['auth token']);
  });
});

describe('githubTokenFor', () => {
  const fakeHealth = (mode: 'local' | 'hosted'): typeof fetch =>
    (async () => new Response(JSON.stringify({ ok: true, mode }), { status: 200 })) as typeof fetch;

  it('refuses to send the token to a non-https, non-loopback hub', async () => {
    const calls: string[][] = [];
    const t = mk('ok', calls, fakeHealth('hosted'));
    await expect(githubTokenFor(t.deps, 'http://hub.example.com')).rejects.toThrow('refusing to send your GitHub token to a non-HTTPS hub');
    expect(calls).toEqual([]);
  });

  it('accepts https hubs and loopback http', async () => {
    const t = mk('ok', [], fakeHealth('hosted'));
    expect(await githubTokenFor(t.deps, 'https://hub.example.com')).toBe(TOKEN);
    expect(await githubTokenFor(t.deps, 'http://localhost:1')).toBe(TOKEN);
  });

  it('returns undefined for a local hub', async () => {
    const t = mk('ok', [], fakeHealth('local'));
    expect(await githubTokenFor(t.deps, 'http://hub.example.com')).toBeUndefined();
  });

  it('health is exposed by HubClient', async () => {
    expect(await new HubClient(hosted.url).health()).toEqual({ ok: true, mode: 'hosted' });
  });
});
