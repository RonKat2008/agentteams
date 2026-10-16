import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type RunningHub } from '@agentteams/hub';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveCredential, type Credential } from '../src/credentials.js';
import { realExec, type CliDeps, type Exec } from '../src/deps.js';
import { HubClient } from '../src/hubClient.js';
import { main } from '../src/main.js';
import { makeTestCli, type FakeExecCall, type TestCli } from './helpers.js';

const ENV_KEYS = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const saved: Record<string, string | undefined> = {};

let hub: RunningHub;
let tmp: string;
let repo: string;
let cli: TestCli;
let claudeCalls: FakeExecCall[];
let client: HubClient;
let orchKey: string;
let inviteCode: string;

const git = async (cwd: string, ...args: string[]) => {
  const r = await realExec('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const fakeClaude = (calls: FakeExecCall[]): Exec => async (cmd, args, opts) => {
  if (cmd !== 'claude') return realExec(cmd, args, opts);
  calls.push({ cmd, args, cwd: opts?.cwd });
  return { code: 0, stdout: '', stderr: '' };
};

const createTask = async (apiKey: string, assignee: string) => {
  const res = await fetch(`${hub.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_task', arguments: { title: 'Login', assignee } } }),
  });
  expect(res.status).toBe(200);
};

const run = (cwd: string, ...args: string[]) => {
  cli.deps.cwd = cwd;
  return main(['node', 'agentteams', ...args], cli.deps);
};

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV_KEYS)) { saved[k] = process.env[k]; process.env[k] = v; }
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'at-wt-')));
  repo = join(tmp, 'proj');
  mkdirSync(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  await git(repo, 'add', 'a.txt');
  await git(repo, 'commit', '-q', '-m', 'init');
  hub = await startHub({ dbPath: join(tmp, 'hub.db'), port: 0 });

  claudeCalls = [];
  cli = makeTestCli({ exec: fakeClaude(claudeCalls), homedir: join(tmp, 'home'), cwd: repo });
  const anon = new HubClient(hub.url);
  const created = await anon.createTeam({ name: 'dev-squad', member: 'ronit', tool: 'claude', repo: { provider: 'local', defaultBranch: 'main' } });
  orchKey = created.apiKey;
  inviteCode = created.inviteCode;
  const joined = await anon.joinTeam({ inviteCode: created.inviteCode, member: 'dylan', tool: 'claude' });
  client = new HubClient(hub.url, { apiKey: joined.apiKey });
  const cred: Credential = {
    repoPath: repo, tool: 'claude', hubUrl: hub.url, teamName: 'dev-squad', agentName: joined.agentName,
    apiKey: joined.apiKey, createdAt: new Date().toISOString(),
  };
  await saveCredential(cli.deps, cred);
  await createTask(created.apiKey, joined.agentName);
});
afterEach(async () => {
  for (const k of Object.keys(ENV_KEYS)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await hub.close();
  cli.cleanup();
  await rm(tmp, { recursive: true, force: true });
});

describe('agentteams worktree', () => {
  it('claims the task and creates branch, worktree and claude config', async () => {
    expect(await run(repo, 'worktree', '1')).toBe(0);
    const wt = join(tmp, 'proj.at', 'dylan-claude-1');
    expect(await git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('at/dylan-claude/1');
    expect(await git(wt, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'main'));
    expect((await client.getTask(1)).status).toBe('in_progress');
    expect(existsSync(join(wt, '.claude', 'settings.local.json'))).toBe(true);
    expect(existsSync(join(wt, 'CLAUDE.md')) && readFileSync(join(wt, 'CLAUDE.md'), 'utf8').includes('agentteams')).toBe(false);
    const add = claudeCalls.find((c) => c.args.slice(0, 2).join(' ') === 'mcp add');
    expect(add?.cwd).toBe(wt);
    expect(cli.out).toContain(`Task #1 claimed. Worktree: ${wt} (branch at/dylan-claude/1)`);
    expect(cli.out).toContain(`Next: cd ${wt} && claude`);
  });

  it('sets up a non-claude agent (gemini) in the worktree: git-excluded config pinned to it, tool-specific Next hint', async () => {
    const anon = new HubClient(hub.url);
    const team = await anon.joinTeam({ inviteCode, member: 'gem', tool: 'gemini' });
    await saveCredential(cli.deps, {
      repoPath: repo, tool: 'gemini', hubUrl: hub.url, teamName: 'dev-squad', agentName: team.agentName,
      apiKey: team.apiKey, createdAt: new Date().toISOString(),
    });
    await createTask(orchKey, team.agentName);
    expect(await run(repo, 'worktree', '2', '--agent', 'gemini')).toBe(0);
    const wt = join(tmp, 'proj.at', `${team.agentName}-2`);
    const settings = JSON.parse(readFileSync(join(wt, '.gemini', 'settings.json'), 'utf8'));
    expect(settings.mcpServers.agentteams.args.slice(-2)).toEqual(['--repo', wt]);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(await git(wt, 'status', '--porcelain')).toBe('');
    expect(cli.out).toContain(`Next: cd ${wt} && gemini`);
  });

  it('is idempotent when run twice', async () => {
    expect(await run(repo, 'worktree', '1')).toBe(0);
    const wt = join(tmp, 'proj.at', 'dylan-claude-1');
    expect(await run(repo, 'worktree', '1')).toBe(0);
    expect(cli.out).toContain(`worktree already exists: ${wt}`);
    expect(cli.out.filter((l) => l.startsWith('Task #1 claimed')).length).toBe(2);
  });

  it('surfaces the hub error for someone else\'s task and creates nothing', async () => {
    await createTask(orchKey, 'ronit-claude');
    expect(await run(repo, 'worktree', '2')).toBe(1);
    expect(cli.err.join('\n')).toMatch(/only the assignee \(ronit-claude\) can claim task #2/);
    expect(existsSync(join(tmp, 'proj.at', 'dylan-claude-2'))).toBe(false);
  });

  it('refuses an unrelated directory at the path and leaves it alone', async () => {
    const wt = join(tmp, 'proj.at', 'dylan-claude-1');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'keep.txt'), 'mine');
    expect(await run(repo, 'worktree', '1')).toBe(1);
    expect(cli.err.join('\n')).toContain(`${wt} exists and is not this task's worktree`);
    expect(readFileSync(join(wt, 'keep.txt'), 'utf8')).toBe('mine');
    expect(existsSync(join(wt, '.git'))).toBe(false);
  });

  it('places the worktree next to the main root when run from a linked worktree', async () => {
    const other = join(tmp, 'elsewhere');
    await git(repo, 'worktree', 'add', '-q', '-b', 'side', other);
    expect(await run(other, 'worktree', '1')).toBe(0);
    expect(existsSync(join(tmp, 'proj.at', 'dylan-claude-1', 'a.txt'))).toBe(true);
    expect(existsSync(join(tmp, 'proj.at', 'dylan-claude-1', '.git'))).toBe(true);
  });

  it('installs the managed git hooks (idempotently) in the shared hooks dir', async () => {
    expect(await run(repo, 'worktree', '1')).toBe(0);
    const pre = join(repo, '.git', 'hooks', 'pre-commit');
    expect(readFileSync(pre, 'utf8')).toContain('# agentteams-managed');
    expect(existsSync(join(repo, '.git', 'hooks', 'post-commit'))).toBe(true);
    expect(existsSync(`${pre}.agentteams-prev`)).toBe(false);
    expect(await run(repo, 'worktree', '1')).toBe(0);
    expect(existsSync(`${pre}.agentteams-prev`)).toBe(false);
  });

  it('install works from inside a linked worktree', async () => {
    expect(await run(repo, 'worktree', '1')).toBe(0);
    const wt = join(tmp, 'proj.at', 'dylan-claude-1');
    cli.err.length = 0;
    expect(await run(wt, 'install')).toBe(0);
    expect(cli.err.join('\n')).not.toContain('no agentteams credentials');
    expect(cli.out.join('\n')).toContain('Installing agentteams for claude (dylan-claude)');
  });

  it('rejects a non-integer task number', async () => {
    expect(await run(repo, 'worktree', 'abc')).toBe(1);
    expect(cli.err.join('\n')).toMatch(/positive integer/);
  });

  describe('--remove', () => {
    const wtPath = () => join(tmp, 'proj.at', 'dylan-claude-1');

    it('removes a clean task worktree, keeps the branch and prints what it removed', async () => {
      expect(await run(repo, 'worktree', '1')).toBe(0);
      cli.out.length = 0;
      expect(await run(repo, 'worktree', '1', '--remove')).toBe(0);
      expect(existsSync(wtPath())).toBe(false);
      expect(await git(repo, 'branch', '--list', 'at/dylan-claude/1')).toContain('at/dylan-claude/1');
      expect(cli.out.join('\n')).toContain(`Removed worktree ${wtPath()} (branch at/dylan-claude/1 kept)`);
      expect(await git(repo, 'worktree', 'list')).not.toContain('dylan-claude-1');
    });

    it('refuses uncommitted changes without --force and leaves the worktree', async () => {
      expect(await run(repo, 'worktree', '1')).toBe(0);
      writeFileSync(join(wtPath(), 'a.txt'), 'changed\n');
      expect(await run(repo, 'worktree', '1', '--remove')).toBe(1);
      expect(cli.err.join('\n')).toContain('uncommitted changes');
      expect(cli.err.join('\n')).toContain('--force');
      expect(readFileSync(join(wtPath(), 'a.txt'), 'utf8')).toBe('changed\n');
    });

    it('refuses untracked files without --force', async () => {
      expect(await run(repo, 'worktree', '1')).toBe(0);
      writeFileSync(join(wtPath(), 'new.txt'), 'x\n');
      expect(await run(repo, 'worktree', '1', '--remove')).toBe(1);
      expect(existsSync(join(wtPath(), 'new.txt'))).toBe(true);
    });

    it('--force removes a dirty worktree', async () => {
      expect(await run(repo, 'worktree', '1')).toBe(0);
      writeFileSync(join(wtPath(), 'a.txt'), 'changed\n');
      expect(await run(repo, 'worktree', '1', '--remove', '--force')).toBe(0);
      expect(existsSync(wtPath())).toBe(false);
      expect(cli.out.join('\n')).toContain(`Removed worktree ${wtPath()}`);
    });

    it('does not claim the task, and errors when there is no worktree', async () => {
      expect(await run(repo, 'worktree', '1', '--remove')).toBe(1);
      expect(cli.err.join('\n')).toContain(`no worktree for task #1 at ${wtPath()}`);
      expect((await client.getTask(1)).status).not.toBe('in_progress');
    });

    it('refuses an unrelated directory at the path', async () => {
      mkdirSync(wtPath(), { recursive: true });
      writeFileSync(join(wtPath(), 'keep.txt'), 'mine');
      expect(await run(repo, 'worktree', '1', '--remove', '--force')).toBe(1);
      expect(readFileSync(join(wtPath(), 'keep.txt'), 'utf8')).toBe('mine');
    });
  });
});
