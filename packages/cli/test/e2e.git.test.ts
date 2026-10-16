import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type RunningHub } from '@agentteams/hub';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveCredential } from '../src/credentials.js';
import { realExec, type CliDeps, type Exec } from '../src/deps.js';
import { runPostCommit, runPreCommit } from '../src/gitHooks.js';
import { HubClient } from '../src/hubClient.js';
import { installGitHooks } from '../src/install/gitHooks.js';
import { main } from '../src/main.js';
import { makeTestCli, type TestCli } from './helpers.js';

/**
 * End-to-end git workflow. Real git, real in-process hub, real CLI `main(argv, deps)`; fake gh and claude.
 * Git hooks: managed hook files are installed with a no-op test command, and the real pre-commit/post-commit
 * logic is run by calling runPreCommit/runPostCommit around the commit (the commit itself is a real
 * `git commit --no-verify`, so the stub hook is not what decides anything).
 */

const cfgDir = mkdtempSync(join(tmpdir(), 'agentteams-e2e-cfg-'));
const identityConfig = join(cfgDir, 'identity');
writeFileSync(identityConfig, '[user]\n\tname = T\n\temail = t@example.com\n');
const ENV_KEYS = { GIT_CONFIG_GLOBAL: identityConfig, GIT_CONFIG_NOSYSTEM: '1' };

const git = async (cwd: string, ...args: string[]) => {
  const r = await realExec('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

interface GhCall { args: string[] }
const ghCalls: GhCall[] = [];
const fakeExec: Exec = async (cmd, args, opts) => {
  if (cmd === 'gh') {
    ghCalls.push({ args });
    if (args[0] === 'repo' && args[1] === 'view') return { code: 0, stdout: 'me/app\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }
  if (cmd === 'claude') return { code: 0, stdout: '', stderr: '' };
  return realExec(cmd, args, opts);
};

const mcp = async (apiKey: string, hubUrl: string, name: string, args: Record<string, unknown>): Promise<string> => {
  const res = await fetch(`${hubUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  return res.text();
};

describe('git workflow end to end', () => {
  const saved: Record<string, string | undefined> = {};
  let hub: RunningHub;
  let tmp: string;
  let remote: string;
  let cloneA: string;
  let cloneB: string;
  let orch: TestCli;
  let worker: TestCli;
  const saveEnv = () => { for (const [k, v] of Object.entries(ENV_KEYS)) { saved[k] = process.env[k]; process.env[k] = v; } };
  const restoreEnv = () => { for (const k of Object.keys(ENV_KEYS)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };

  const run = (t: TestCli, cwd: string, ...args: string[]) => {
    t.deps.cwd = cwd;
    return main(['node', 'agentteams', ...args], t.deps);
  };
  const hookDeps = (t: TestCli, cwd: string, env: NodeJS.ProcessEnv = {}): CliDeps => ({ ...t.deps, cwd, env: { ...t.deps.env, ...env } });

  beforeAll(async () => {
    saveEnv();
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'at-e2e-')));
    remote = join(tmp, 'remote.git');
    cloneA = join(tmp, 'a', 'app');
    cloneB = join(tmp, 'b', 'app');
    mkdirSync(cloneA, { recursive: true });
    await git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(cloneA, 'init', '-q', '-b', 'main');
    mkdirSync(join(cloneA, 'src'));
    writeFileSync(join(cloneA, 'src', 'shared.ts'), 'export const x = 1;\n');
    await git(cloneA, 'add', 'src/shared.ts');
    await git(cloneA, 'commit', '-q', '-m', 'init');
    await git(cloneA, 'remote', 'add', 'origin', remote);
    await git(cloneA, 'push', '-q', '-u', 'origin', 'main');
    await git(tmp, 'clone', '-q', remote, cloneB);

    hub = await startHub({ dbPath: join(tmp, 'hub.db'), port: 0 });
    // Per-agent deps: different AGENTTEAMS_HOME and homedir simulate two machines.
    orch = makeTestCli({ exec: fakeExec, cwd: cloneA, env: { AGENTTEAMS_HOME: join(tmp, 'home-a', '.agentteams') }, homedir: join(tmp, 'home-a') });
    worker = makeTestCli({ exec: fakeExec, cwd: cloneB, env: { AGENTTEAMS_HOME: join(tmp, 'home-b', '.agentteams') }, homedir: join(tmp, 'home-b') });
  });

  afterAll(async () => {
    restoreEnv();
    await hub.close();
    orch.cleanup();
    worker.cleanup();
    await rm(tmp, { recursive: true, force: true });
    await rm(cfgDir, { recursive: true, force: true });
  });

  it('runs create, join, worktree, claim guard, done and merged', async () => {
    // 1. create + join
    expect(await run(orch, cloneA, 'create', 'app', '--repo', 'me/app', '--hub', hub.url, '--no-install')).toBe(0);
    const code = /Invite code: (\S+)/.exec(orch.out.join('\n'))?.[1];
    expect(code).toBeTruthy();
    expect(await run(worker, cloneB, 'join', code!, '--hub', hub.url, '--no-install', '--no-clone')).toBe(0);
    const orchCred = (await resolveCredential(orch.deps, cloneA, 'claude'))!;
    const workerCred = (await resolveCredential(worker.deps, cloneB, 'claude'))!;
    expect(orchCred.teamName).toBe(workerCred.teamName);
    const orchClient = new HubClient(hub.url, { apiKey: orchCred.apiKey });
    const workerClient = new HubClient(hub.url, { apiKey: workerCred.apiKey });
    const w = workerCred.agentName;

    // 2. tasks for the worker
    await mcp(orchCred.apiKey, hub.url, 'create_task', { title: 'Shared change', assignee: w });
    await mcp(orchCred.apiKey, hub.url, 'create_task', { title: 'Second', assignee: w });

    // 3. worktree
    expect(await run(worker, cloneB, 'worktree', '1')).toBe(0);
    const wt = join(tmp, 'b', 'app.at', `${w}-1`);
    expect(existsSync(wt)).toBe(true);
    expect(await git(wt, 'symbolic-ref', '--short', 'HEAD')).toBe(`at/${w}/1`);
    expect((await workerClient.getTask(1)).status).toBe('in_progress');

    // 4. claim guard
    const hooks = await installGitHooks(worker.deps, wt, { command: '/usr/bin/true' });
    expect(hooks.status).toBe('installed');
    const claimRes = await mcp(orchCred.apiKey, hub.url, 'claim_files', { globs: ['src/shared.ts'], exclusive: true });
    expect(claimRes).toContain('src/shared.ts');
    writeFileSync(join(wt, 'src', 'shared.ts'), 'export const x = 2;\n');
    await git(wt, 'add', 'src/shared.ts');

    const blocked = hookDeps(worker, wt);
    const errsBefore = worker.err.length;
    expect(await runPreCommit(blocked)).toBe(3);
    expect(worker.err.slice(errsBefore).join('\n')).toContain(orchCred.agentName);

    const allowed = hookDeps(worker, wt, { AGENTTEAMS_ALLOW: '1' });
    expect(await runPreCommit(allowed)).toBe(0);
    await git(wt, 'commit', '-q', '--no-verify', '-m', 'change shared');
    const sha = await git(wt, 'rev-parse', 'HEAD');
    const events = await orchClient.activity({ limit: 100 });
    expect(events.map((e) => e.type)).toContain('claim_overridden');

    // 5. post-commit
    expect(await runPostCommit(blocked)).toBe(0);
    const changes = await mcp(orchCred.apiKey, hub.url, 'get_changes', {});
    expect(changes).toContain(sha);
    const orchInbox = (await orchClient.ping()).messages;
    expect(orchInbox.some((m) => m.kind === 'fyi' && m.body.includes('src/shared.ts'))).toBe(true);

    // 6. done
    expect(await run(worker, wt, 'done', '1', '-m', 'did it')).toBe(0);
    expect(await git(remote, 'rev-parse', '--verify', `refs/heads/at/${w}/1`)).toBe(sha);
    const done = await workerClient.getTask(1);
    expect(done.status).toBe('done');
    expect(done.summary).toBe('did it');
    expect((await orchClient.ping()).messages.some((m) => m.kind === 'fyi' && m.body.includes('Task #1 done'))).toBe(true);

    // 7. merge + merged
    await git(cloneA, 'fetch', '-q', 'origin');
    await git(cloneA, 'merge', '--no-ff', '-q', '-m', 'merge task 1', `origin/at/${w}/1`);
    await git(cloneA, 'push', '-q', 'origin', 'main');
    expect(await run(orch, cloneA, 'merged', '1')).toBe(0);
    expect((await workerClient.getTask(1)).mergedAt).not.toBeNull();
    expect((await workerClient.ping()).messages.some((m) => m.kind === 'fyi' && m.body.includes('merged'))).toBe(true);
    expect(ghCalls.every((c) => c.args[0] === 'repo')).toBe(true);
  });
});
