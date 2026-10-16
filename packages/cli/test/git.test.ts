import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveCredential, resolveCredentialForCwd, type Credential } from '../src/credentials.js';
import { realExec, type Exec } from '../src/deps.js';
import { currentBranch, defaultBranch, gitPath, gitTopLevel, headCommit, hooksPathConfigured, mainRepoRoot, stagedFiles } from '../src/git.js';
import { installClaude } from '../src/install/claude.js';
import { makeTestCli } from './helpers.js';

const ENV_KEYS = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const saved: Record<string, string | undefined> = {};
const deps = { exec: realExec };
let tmp: string;
let main: string;

const git = async (cwd: string, ...args: string[]) => {
  const r = await realExec('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const rp = (p: string) => realpathSync(p);

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV_KEYS)) { saved[k] = process.env[k]; process.env[k] = v; }
  tmp = rp(mkdtempSync(join(tmpdir(), 'at-git-')));
  main = join(tmp, 'main');
  mkdirSync(main);
  await git(main, 'init', '-q', '-b', 'dev');
});
afterEach(async () => {
  for (const k of Object.keys(ENV_KEYS)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await rm(tmp, { recursive: true, force: true });
});

describe('headCommit', () => {
  it('summarises a root commit with a binary file', async () => {
    writeFileSync(join(main, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(main, 'b.txt'), 'x\n');
    writeFileSync(join(main, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255, 0]));
    await git(main, 'add', 'a.txt', 'b.txt', 'bin.dat');
    await git(main, 'commit', '-q', '-m', 'root commit');
    const h = await headCommit(deps, main);
    expect(h.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(h.branch).toBe('dev');
    expect(h.message.trim()).toBe('root commit');
    expect(h.files.sort()).toEqual(['a.txt', 'b.txt', 'bin.dat']);
    expect(h.insertions).toBe(4);
    expect(h.deletions).toBe(0);
  });
  it('reports branch HEAD when detached', async () => {
    writeFileSync(join(main, 'a.txt'), 'a\n');
    await git(main, 'add', 'a.txt');
    await git(main, 'commit', '-q', '-m', 'c1');
    await git(main, 'checkout', '-q', '--detach');
    expect((await headCommit(deps, main)).branch).toBe('HEAD');
    expect(await currentBranch(deps, main)).toBe('HEAD');
  });
});

describe('stagedFiles', () => {
  it('includes deletions and paths with spaces', async () => {
    writeFileSync(join(main, 'gone.txt'), 'x\n');
    await git(main, 'add', 'gone.txt');
    await git(main, 'commit', '-q', '-m', 'c1');
    await git(main, 'rm', '-q', 'gone.txt');
    writeFileSync(join(main, 'with space.txt'), 'y\n');
    await git(main, 'add', 'with space.txt');
    expect((await stagedFiles(deps, main)).sort()).toEqual(['gone.txt', 'with space.txt']);
  });
});

describe('linked worktree paths', () => {
  let wt: string;
  beforeEach(async () => {
    writeFileSync(join(main, 'a.txt'), 'a\n');
    await git(main, 'add', 'a.txt');
    await git(main, 'commit', '-q', '-m', 'c1');
    wt = join(tmp, 'main.at', 'agent-1');
    await git(main, 'worktree', 'add', '-q', '-b', 'at/agent/1', wt);
  });
  it('resolves the main root and common git paths', async () => {
    expect(rp((await gitTopLevel(deps, wt))!)).toBe(wt);
    expect(rp((await mainRepoRoot(deps, wt))!)).toBe(main);
    expect(rp(await gitPath(deps, wt, 'hooks'))).toBe(join(main, '.git', 'hooks'));
    expect(await gitPath(deps, wt, 'info/exclude')).toBe(join(main, '.git', 'info', 'exclude'));
    expect(await hooksPathConfigured(deps, wt)).toBeNull();
  });
  it('resolveCredentialForCwd falls back to the main repo credential', async () => {
    const t = makeTestCli();
    try {
      const cred: Credential = { repoPath: main, tool: 'claude', hubUrl: 'http://x', teamName: 't', agentName: 'a', apiKey: 'k', createdAt: 'x' };
      await saveCredential(t.deps, cred);
      const d = { ...t.deps, exec: realExec };
      expect(await resolveCredentialForCwd(d, wt, 'claude')).toMatchObject({ agentName: 'a' });
      expect(await resolveCredentialForCwd(d, tmp, 'claude')).toBeNull();
    } finally { t.cleanup(); }
  });
  it('installClaude writes the exclude line into the common info/exclude', async () => {
    const t = makeTestCli({ exec: (c, a, o) => (c === 'claude' ? Promise.resolve({ code: 0, stdout: '', stderr: '' }) : realExec(c, a, o)) });
    try {
      const cred: Credential = { repoPath: wt, tool: 'claude', hubUrl: 'http://x', teamName: 't', agentName: 'a', apiKey: 'k', createdAt: 'x' };
      await installClaude(t.deps, cred, { cli: 'x' });
      expect(readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')).toContain('.claude/settings.local.json');
    } finally { t.cleanup(); }
  });
});

describe('defaultBranch', () => {
  it('uses origin/HEAD', async () => {
    const bare = join(tmp, 'remote.git');
    await git(tmp, 'init', '-q', '--bare', '-b', 'trunk', bare);
    writeFileSync(join(main, 'a.txt'), 'a\n');
    await git(main, 'add', 'a.txt');
    await git(main, 'commit', '-q', '-m', 'c1');
    await git(main, 'branch', '-m', 'trunk');
    await git(main, 'remote', 'add', 'origin', bare);
    await git(main, 'push', '-q', 'origin', 'trunk');
    await git(main, 'remote', 'set-head', 'origin', '-a');
    await git(main, 'checkout', '-q', '-b', 'feature');
    expect(await defaultBranch(deps, main)).toBe('trunk');
  });
  it('falls back to the current branch, then main', async () => {
    expect(await defaultBranch(deps, main)).toBe('dev');
    expect(await defaultBranch(deps, tmp)).toBe('main');
  });
  it('uses gh when a slug is known', async () => {
    const exec: Exec = (c, a, o) => (c === 'gh' ? Promise.resolve({ code: 0, stdout: 'develop\n', stderr: '' }) : realExec(c, a, o));
    expect(await defaultBranch({ exec }, main, 'o/r')).toBe('develop');
    const failing: Exec = (c, a, o) => (c === 'gh' ? Promise.resolve({ code: 1, stdout: '', stderr: 'x' }) : realExec(c, a, o));
    expect(await defaultBranch({ exec: failing }, main, 'o/r')).toBe('dev');
  });
});
