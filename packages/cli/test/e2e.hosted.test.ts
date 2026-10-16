import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type RunningHub } from '@agentteams/hub';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveCredential } from '../src/credentials.js';
import { realExec, type Exec } from '../src/deps.js';
import { HubClient } from '../src/hubClient.js';
import { main } from '../src/main.js';
import { makeTestCli, type TestCli } from './helpers.js';

/**
 * Hosted team end to end: in-process hosted hub (SQLite; startHub cannot take an injected PGlite db),
 * fake GitHub verifier, two members with separate homes, fake `gh` through exec.
 */

const TOKENS: Record<string, string> = { 'tok-ronit': 'ronit', 'tok-dylan': 'DylanX' };
const ENV = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const saved: Record<string, string | undefined> = {};

const ghFor = (token: string | null, calls: string[][]): Exec => async (cmd, args, opts) => {
  if (cmd === 'claude') return { code: 0, stdout: '', stderr: '' };
  if (cmd === 'gh') {
    calls.push(args);
    if (args[0] === 'auth' && args[1] === 'token') {
      return token ? { code: 0, stdout: `${token}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }
  return realExec(cmd, args, opts);
};

describe('hosted team end to end', () => {
  let hub: RunningHub;
  let dir: string;
  const clis: TestCli[] = [];
  const ronitGh: string[][] = [];
  const mk = (name: string, token: string | null, calls: string[][]): TestCli => {
    const t = makeTestCli({ exec: ghFor(token, calls), env: { AGENTTEAMS_HOME: join(dir, name, '.agentteams') }, homedir: join(dir, name) });
    clis.push(t);
    return t;
  };
  const run = (t: TestCli, ...args: string[]) => main(['node', 'agentteams', ...args], t.deps);
  const everything = () => clis.flatMap((t) => [...t.out, ...t.err, ...t.raw]).join('\n');

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    dir = mkdtempSync(join(tmpdir(), 'at-e2e-hosted-'));
    hub = await startHub({
      dbPath: join(dir, 'hub.db'), port: 0, mode: 'hosted', allowedHosts: ['127.0.0.1', 'localhost'],
      verifyGithub: async (token) => {
        const login = TOKENS[token];
        if (!login) throw new Error('bad token');
        return { login, id: login === 'ronit' ? 1 : 2 };
      },
    });
  });
  afterAll(async () => {
    for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await hub.close();
    clis.forEach((c) => c.cleanup());
    rmSync(dir, { recursive: true, force: true });
  });

  it('create, join, access request, grant, task claim, status, and no token leaks', async () => {
    const ronit = mk('ronit', 'tok-ronit', ronitGh);
    await realExec('git', ['init', '-q'], { cwd: ronit.deps.cwd });
    expect(await run(ronit, 'create', 'app', '--repo', 'me/app', '--hub', hub.url, '--no-install')).toBe(0);
    const rc = (await resolveCredential(ronit.deps, ronit.deps.cwd, 'claude'))!;
    expect(rc.agentName).toBe('ronit-claude');
    const code = /Invite code: (\S+)/.exec(ronit.out.join('\n'))![1]!;

    const dylan = mk('dylan', 'tok-dylan', []);
    await realExec('git', ['init', '-q'], { cwd: dylan.deps.cwd });
    expect(await run(dylan, 'join', code, '--hub', hub.url, '--agent', 'codex', '--no-install', '--no-clone')).toBe(0);
    const dc = (await resolveCredential(dylan.deps, dylan.deps.cwd, 'codex'))!;
    expect(dc.agentName).toBe('dylanx-codex');

    const ronitClient = new HubClient(hub.url, { apiKey: rc.apiKey });
    const dylanClient = new HubClient(hub.url, { apiKey: dc.apiKey });
    const status0 = await ronitClient.status();
    expect(status0.agents.find((a) => a.name === 'dylanx-codex')?.githubLogin).toBe('DylanX');

    const inbox = (await ronitClient.ping()).messages;
    expect(inbox.some((m) => m.kind === 'fyi' && m.body.includes('agentteams access grant dylanx-codex'))).toBe(true);

    expect(await run(ronit, 'access', 'grant', 'dylanx-codex', '--yes')).toBe(0);
    expect(ronitGh).toContainEqual(['api', '-X', 'PUT', 'repos/me/app/collaborators/DylanX', '-f', 'permission=push']);

    const res = await fetch(`${hub.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${rc.apiKey}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { title: 'Hosted task', assignee: 'dylanx-codex' } } }),
    });
    expect(res.status).toBe(200);
    const claimed = await dylanClient.claimTask(1);
    expect(claimed.status).toBe('in_progress');

    expect(await run(ronit, 'status')).toBe(0);
    expect(ronit.out.join('\n')).toContain('@DylanX');

    // A join without a gh token is refused.
    const nogh = mk('nogh', null, []);
    expect(await run(nogh, 'join', code, '--hub', hub.url, '--no-install', '--no-clone')).toBe(1);
    expect(nogh.err.join('\n')).toContain('gh is not logged in');

    const out = everything();
    expect(out).not.toContain('tok-ronit');
    expect(out).not.toContain('tok-dylan');
  });
});
