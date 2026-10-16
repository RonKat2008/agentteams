import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type RunningHub } from '@agentteams/hub';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveCredential } from '../src/credentials.js';
import type { Exec } from '../src/deps.js';
import { HubClient } from '../src/hubClient.js';
import { main } from '../src/main.js';
import { makeTestCli, type TestCli } from './helpers.js';

let hosted: RunningHub;
let local: RunningHub;
let dbDir: string;
let ownerKey = '';
let localKey = '';
const clis: TestCli[] = [];
const run = (t: TestCli, ...args: string[]) => main(['node', 'agentteams', ...args], t.deps);

interface Opts { allow?: boolean; ci?: string; agents?: { name: string; githubLogin: string | null }[]; tty?: boolean; answer?: string; ghFail?: boolean; local?: boolean }
async function cli(o: Opts = {}): Promise<{ t: TestCli; gh: string[][]; prompts: string[] }> {
  const gh: string[][] = [];
  const prompts: string[] = [];
  const exec: Exec = async (cmd, args) => {
    if (cmd === 'gh') {
      gh.push(args);
      return o.ghFail ? { code: 1, stdout: '', stderr: 'HTTP 403: forbidden\nmore' } : { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const fakeFetch = o.agents
    ? ((async () => new Response(JSON.stringify({
      team: { name: 'acc', repo: { provider: 'github', slug: 'me/app', defaultBranch: 'main' }, orchestrator: null },
      agents: o.agents.map((a) => ({ ...a, member: 'm', tool: 'claude', presence: 'online', currentTask: null, claims: [] })),
    }), { status: 200 })) as typeof fetch)
    : undefined;
  const t = makeTestCli({
    ...(fakeFetch ? { fetch: fakeFetch } : {}),
    exec, isTTY: o.tty ?? false, env: o.allow ? { AGENTTEAMS_ALLOW_GRANT: '1', CI: o.ci ?? '1' } : {},
    prompt: async (q) => { prompts.push(q); return o.answer ?? ''; },
  });
  clis.push(t);
  await saveCredential(t.deps, {
    repoPath: t.deps.cwd, tool: 'claude', hubUrl: o.local ? local.url : hosted.url,
    teamName: 'acc', agentName: 'x', apiKey: o.local ? localKey : ownerKey, createdAt: new Date().toISOString(),
  });
  return { t, gh, prompts };
}

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'agentteams-access-db-'));
  hosted = await startHub({
    dbPath: join(dbDir, 'h.db'), port: 0, mode: 'hosted', allowedHosts: ['127.0.0.1', 'localhost'],
    verifyGithub: async (token) => (token === 'tok-b' ? { login: 'bob', id: 2 } : { login: 'alice', id: 1 }),
  });
  local = await startHub({ dbPath: join(dbDir, 'l.db'), port: 0 });
  const c = new HubClient(hosted.url);
  const team = await c.createTeam({ name: 'acc', tool: 'claude', repo: { provider: 'github', slug: 'me/app', defaultBranch: 'main' }, githubToken: 'tok-a' });
  ownerKey = team.apiKey;
  await c.joinTeam({ inviteCode: team.inviteCode, tool: 'claude', githubToken: 'tok-b' });
  localKey = (await new HubClient(local.url).createTeam({ name: 'loc', member: 'zed', tool: 'claude', repo: { provider: 'local', defaultBranch: 'main' } })).apiKey;
});
afterAll(async () => {
  await hosted.close(); await local.close();
  rmSync(dbDir, { recursive: true, force: true });
  clis.forEach((c) => c.cleanup());
});

const PUT = ['api', '-X', 'PUT', 'repos/me/app/collaborators/bob', '-f', 'permission=push'];

describe('access grant', () => {
  it('--yes plus AGENTTEAMS_ALLOW_GRANT=1 calls gh with the exact args (by login)', async () => {
    const { t, gh } = await cli({ allow: true });
    expect(await run(t, 'access', 'grant', 'bob', '--yes')).toBe(0);
    expect(gh).toEqual([PUT]);
    expect(t.out.join('\n')).toContain('Invited @bob to me/app with push access (they must accept the GitHub invitation).');
  });

  it('--yes plus AGENTTEAMS_ALLOW_GRANT=1 without CI is refused', async () => {
    const { t, gh } = await cli({ allow: true, ci: '' });
    expect(await run(t, 'access', 'grant', 'bob', '--yes')).toBe(1);
    expect(gh).toEqual([]);
  });

  it('CI=true is accepted as well as CI=1', async () => {
    const { t, gh } = await cli({ allow: true, ci: 'true' });
    expect(await run(t, 'access', 'grant', 'bob', '--yes')).toBe(0);
    expect(gh).toEqual([PUT]);
  });

  it('resolves an agent name to its login', async () => {
    const { t, gh } = await cli({ allow: true });
    const status = await new HubClient(hosted.url, { apiKey: ownerKey }).status();
    const bobAgent = status.agents.find((a) => a.githubLogin === 'bob')!.name;
    expect(await run(t, 'access', 'grant', bobAgent, '--yes')).toBe(0);
    expect(gh).toEqual([PUT]);
  });

  it('on a TTY, y grants and the prompt names the repo and login', async () => {
    const { t, gh, prompts } = await cli({ tty: true, answer: 'Y' });
    expect(await run(t, 'access', 'grant', 'bob')).toBe(0);
    expect(prompts).toEqual(['Grant push access to me/app for GitHub user bob? [y/N] ']);
    expect(gh).toEqual([PUT]);
  });

  it('on a TTY, n does nothing', async () => {
    const { t, gh } = await cli({ tty: true, answer: 'n' });
    expect(await run(t, 'access', 'grant', 'bob')).toBe(0);
    expect(gh).toEqual([]);
    expect(t.out.join('\n')).not.toContain('Invited');
  });

  const REFUSAL = 'access grant needs a human: run it in your own terminal (agents cannot grant repo access)';

  it('without a TTY and without --yes, refuses with no mention of --yes', async () => {
    const { t, gh } = await cli();
    expect(await run(t, 'access', 'grant', 'bob')).toBe(1);
    expect(t.err.join('\n')).toContain(REFUSAL);
    expect(t.err.join('\n')).not.toContain('--yes');
    expect(gh).toEqual([]);
  });

  it('without a TTY, --yes alone is not enough', async () => {
    const { t, gh } = await cli();
    expect(await run(t, 'access', 'grant', 'bob', '--yes')).toBe(1);
    expect(t.err.join('\n')).toContain(REFUSAL);
    expect(t.err.join('\n')).not.toContain('--yes');
    expect(t.err.join('\n')).not.toContain('AGENTTEAMS_ALLOW_GRANT');
    expect(gh).toEqual([]);
  });

  it('without a TTY, AGENTTEAMS_ALLOW_GRANT=1 alone (no --yes) is not enough', async () => {
    const { t, gh } = await cli({ allow: true });
    expect(await run(t, 'access', 'grant', 'bob')).toBe(1);
    expect(gh).toEqual([]);
  });

  it('on a TTY, --yes without the env var still prompts and n cancels', async () => {
    const { t, gh, prompts } = await cli({ tty: true, answer: 'n' });
    expect(await run(t, 'access', 'grant', 'bob', '--yes')).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(gh).toEqual([]);
  });

  it('unknown agent errors', async () => {
    const { t, gh } = await cli();
    expect(await run(t, 'access', 'grant', 'nobody', '--yes')).toBe(1);
    expect(t.err.join('\n')).toContain('nobody');
    expect(gh).toEqual([]);
  });

  it('a local team errors', async () => {
    const { t, gh } = await cli({ local: true });
    expect(await run(t, 'access', 'grant', 'zed', '--yes')).toBe(1);
    expect(t.err.join('\n')).toContain('GitHub');
    expect(gh).toEqual([]);
  });

  it('gh failure surfaces the first stderr line', async () => {
    const { t } = await cli({ ghFail: true, allow: true });
    expect(await run(t, 'access', 'grant', 'bob', '--yes')).toBe(1);
    expect(t.err.join('\n')).toContain('HTTP 403: forbidden');
    expect(t.err.join('\n')).not.toContain('more');
  });

  it.each(['a-', 'a--b', '-a'])('refuses an invalid hub-supplied login %s without calling gh', async (bad) => {
    const { t, gh } = await cli({ agents: [{ name: 'evil-claude', githubLogin: bad }] });
    expect(await run(t, 'access', 'grant', 'evil-claude', '--yes')).toBe(1);
    expect(t.err.join('\n')).toContain('invalid GitHub login');
    expect(gh).toEqual([]);
  });

  it('refuses a target matching two different GitHub users', async () => {
    const { t, gh } = await cli({ agents: [{ name: 'bob', githubLogin: 'alice' }, { name: 'x-claude', githubLogin: 'bob' }] });
    expect(await run(t, 'access', 'grant', 'bob', '--yes')).toBe(1);
    expect(t.err.join('\n')).toContain('"bob" matches more than one GitHub user (alice, bob); use the agent name');
    expect(gh).toEqual([]);
  });
});
