import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type RunningHub } from '@agentteams/hub';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveCredential, type Credential } from '../src/credentials.js';
import { realExec, type Exec } from '../src/deps.js';
import { HubClient } from '../src/hubClient.js';
import { main } from '../src/main.js';
import { makeTestCli, type TestCli } from './helpers.js';

const gitConfigDir = mkdtempSync(join(tmpdir(), 'agentteams-fin-cfg-'));
const identityConfig = join(gitConfigDir, 'identity');
writeFileSync(identityConfig, '[user]\n\tname = T\n\temail = t@example.com\n');
const ENV_KEYS = { GIT_CONFIG_GLOBAL: identityConfig, GIT_CONFIG_NOSYSTEM: '1' };
const saved: Record<string, string | undefined> = {};

interface GhCall { args: string[]; cwd?: string }
let hub: RunningHub;
let tmp: string;
let repo: string;
let remote: string;
let cli: TestCli;
let ghCalls: GhCall[];
let ghReply: (args: string[]) => { code: number; stdout?: string; stderr?: string };
let orchKey: string;
let agentName: string;
let agentKey: string;
let agentClient: HubClient;

const git = async (cwd: string, ...args: string[]) => {
  const r = await realExec('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const fakeGh: Exec = async (cmd, args, opts) => {
  if (cmd !== 'gh') return realExec(cmd, args, opts);
  ghCalls.push({ args, cwd: opts?.cwd });
  return { code: 0, stdout: '', stderr: '', ...ghReply(args) };
};
const mcp = async (apiKey: string, name: string, args: Record<string, unknown>) => {
  const res = await fetch(`${hub.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
};
const run = (cwd: string, ...args: string[]) => {
  cli.deps.cwd = cwd;
  return main(['node', 'agentteams', ...args], cli.deps);
};
const onTaskBranch = async () => {
  await git(repo, 'checkout', '-q', '-b', `at/${agentName}/1`);
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  await git(repo, 'add', 'b.txt');
  await git(repo, 'commit', '-q', '-m', 'work');
};

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV_KEYS)) { saved[k] = process.env[k]; process.env[k] = v; }
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'at-fin-')));
  remote = join(tmp, 'remote.git');
  repo = join(tmp, 'proj');
  mkdirSync(repo);
  await git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  await git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  await git(repo, 'add', 'a.txt');
  await git(repo, 'commit', '-q', '-m', 'init');
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'push', '-q', '-u', 'origin', 'main');

  hub = await startHub({ dbPath: join(tmp, 'hub.db'), port: 0 });
  ghCalls = [];
  ghReply = () => ({ code: 0 });
  cli = makeTestCli({ exec: fakeGh, homedir: join(tmp, 'home'), cwd: repo });
  const anon = new HubClient(hub.url);
  const created = await anon.createTeam({ name: 'dev-squad', member: 'ronit', tool: 'claude', repo: { provider: 'github', slug: 'me/app', defaultBranch: 'main' } });
  orchKey = created.apiKey;
  const joined = await anon.joinTeam({ inviteCode: created.inviteCode, member: 'dylan', tool: 'claude' });
  agentName = joined.agentName;
  agentKey = joined.apiKey;
  agentClient = new HubClient(hub.url, { apiKey: agentKey });
  const cred: Credential = {
    repoPath: repo, tool: 'claude', hubUrl: hub.url, teamName: 'dev-squad', agentName,
    apiKey: agentKey, createdAt: new Date().toISOString(),
  };
  await saveCredential(cli.deps, cred);
  await mcp(orchKey, 'create_task', { title: 'Login', assignee: agentName });
  await agentClient.claimTask(1);
});
afterEach(async () => {
  for (const k of Object.keys(ENV_KEYS)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await hub.close();
  cli.cleanup();
  await rm(tmp, { recursive: true, force: true });
});

describe('agentteams done', () => {
  it('pushes the task branch and completes the task', async () => {
    await onTaskBranch();
    const branch = `at/${agentName}/1`;
    expect(await run(repo, 'done', '1', '-m', 'login works')).toBe(0);
    expect(await git(remote, 'rev-parse', '--verify', `refs/heads/${branch}`)).toBe(await git(repo, 'rev-parse', 'HEAD'));
    const task = await agentClient.getTask(1);
    expect(task.status).toBe('done');
    expect(task.branch).toBe(branch);
    expect(task.summary).toBe('login works');
    expect(cli.out).toContain(`Task #1 done on ${branch}. The orchestrator has been notified.`);
  });

  it('warns about uncommitted changes but still completes', async () => {
    await onTaskBranch();
    writeFileSync(join(repo, 'dirty.txt'), 'x');
    expect(await run(repo, 'done', '1', '-m', 's')).toBe(0);
    expect(cli.err.join('\n')).toMatch(/uncommitted changes/);
  });

  it('errors on the default branch', async () => {
    expect(await run(repo, 'done', '1', '-m', 's')).toBe(1);
    expect(cli.err.join('\n')).toContain("run this on the task's branch (expected at/<agent>/<task>)");
    expect((await agentClient.getTask(1)).status).not.toBe('done');
  });

  it('errors on a detached HEAD', async () => {
    await git(repo, 'checkout', '-q', '--detach');
    expect(await run(repo, 'done', '1', '-m', 's')).toBe(1);
    expect(cli.err.join('\n')).toContain("run this on the task's branch");
  });

  it('leaves the task not done when the push fails', async () => {
    await onTaskBranch();
    await git(repo, 'remote', 'set-url', 'origin', join(tmp, 'missing.git'));
    expect(await run(repo, 'done', '1', '-m', 's')).toBe(1);
    expect(cli.err.join('\n')).toMatch(/git push/);
    expect((await agentClient.getTask(1)).status).not.toBe('done');
  });

  it('refuses a branch that belongs to a different task', async () => {
    await git(repo, 'checkout', '-q', '-b', `at/${agentName}/2`);
    expect(await run(repo, 'done', '1', '-m', 's')).toBe(1);
    expect(cli.err.join('\n')).toContain('this branch belongs to task #2');
    expect((await agentClient.getTask(1)).status).not.toBe('done');
  });

  it('requires -m', async () => {
    await onTaskBranch();
    expect(await run(repo, 'done', '1')).toBe(1);
  });
});

describe('agentteams pr', () => {
  const completeOnBranch = async () => {
    await onTaskBranch();
    await run(repo, 'done', '1', '-m', 'login works');
    cli.out.length = 0;
  };

  it('passes the gh args exactly and prints the URL', async () => {
    await completeOnBranch();
    ghReply = () => ({ code: 0, stdout: 'https://github.com/me/app/pull/7\n' });
    expect(await run(repo, 'pr', '1')).toBe(0);
    expect(ghCalls).toEqual([{
      args: ['pr', 'create', '--base', 'main', '--head', `at/${agentName}/1`, '--title', '#1: Login', '--body', 'login works\n\nagentteams task #1'],
      cwd: repo,
    }]);
    expect(cli.out).toContain('https://github.com/me/app/pull/7');
  });

  it('prints the existing PR URL when one already exists', async () => {
    await completeOnBranch();
    ghReply = (args) => args[1] === 'create'
      ? { code: 1, stderr: 'a pull request for branch "x" into branch "main" already exists:\nhttps://github.com/me/app/pull/7' }
      : { code: 0, stdout: 'https://github.com/me/app/pull/7\n' };
    expect(await run(repo, 'pr', '1')).toBe(0);
    expect(ghCalls[1]!.args).toEqual(['pr', 'view', `at/${agentName}/1`, '--json', 'url', '-q', '.url']);
    expect(cli.out).toContain('https://github.com/me/app/pull/7');
  });

  it('surfaces other gh failures', async () => {
    await completeOnBranch();
    ghReply = () => ({ code: 1, stderr: 'boom' });
    expect(await run(repo, 'pr', '1')).toBe(1);
    expect(cli.err.join('\n')).toContain('boom');
  });

  it('rejects a hub-supplied branch that looks like an option, without calling gh', async () => {
    await agentClient.completeTask(1, 's', '--delete-branch');
    expect(await run(repo, 'pr', '1')).toBe(1);
    expect(cli.err.join('\n')).toContain('invalid branch name');
    expect(ghCalls).toEqual([]);
  });

  it('rejects a hub-supplied branch that is not a valid ref name', async () => {
    await agentClient.completeTask(1, 's', 'bad..name');
    expect(await run(repo, 'pr', '1')).toBe(1);
    expect(cli.err.join('\n')).toContain('invalid branch name');
    expect(ghCalls).toEqual([]);
  });

  it('errors when the task has no branch yet', async () => {
    expect(await run(repo, 'pr', '1')).toBe(1);
    expect(cli.err.join('\n')).toContain('task #1 has no branch yet; the assignee runs agentteams done first');
    expect(ghCalls).toEqual([]);
  });
});

describe('agentteams merged', () => {
  const asOrchestrator = async () => {
    const cred: Credential = {
      repoPath: repo, tool: 'codex', hubUrl: hub.url, teamName: 'dev-squad', agentName: 'ronit-codex',
      apiKey: orchKey, createdAt: new Date().toISOString(),
    };
    await saveCredential(cli.deps, cred);
  };

  it('records the task as merged when run by the orchestrator', async () => {
    await onTaskBranch();
    await run(repo, 'done', '1', '-m', 's');
    await asOrchestrator();
    expect(await run(repo, 'merged', '1', '--pr', 'https://github.com/me/app/pull/7', '--agent', 'codex')).toBe(0);
    expect((await agentClient.getTask(1)).mergedAt).not.toBeNull();
    expect(cli.out).toContain('Recorded task #1 as merged.');
  });

  it('is forbidden for a non-orchestrator', async () => {
    await onTaskBranch();
    await run(repo, 'done', '1', '-m', 's');
    expect(await run(repo, 'merged', '1')).toBe(1);
    expect(cli.err.join('\n')).toMatch(/only the orchestrator/);
  });
});
