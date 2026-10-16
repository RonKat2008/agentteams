import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realExec } from '../src/deps.js';
import { installGitHooks } from '../src/install/gitHooks.js';

const ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const saved: Record<string, string | undefined> = {};
const deps = { exec: realExec };
let tmp: string;
let repo: string;
let standin: string;
let command: string;
const commitFile = async (n = 'a.txt') => {
  writeFileSync(join(repo, n), `${n}\n`);
  await git(repo, 'add', n);
  return realExec('git', ['commit', '-q', '-m', 'x'], { cwd: repo });
};
const mkStandin = (name: string, body: string) => {
  const p = join(tmp, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
};

const git = async (cwd: string, ...args: string[]) => {
  const r = await realExec('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const mode = (p: string) => statSync(p).mode & 0o777;

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'at-ghooks-')));
  repo = join(tmp, 'repo');
  mkdirSync(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  standin = join(tmp, 'standin.sh');
  writeFileSync(standin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  command = standin;
});
afterEach(async () => {
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await rm(tmp, { recursive: true, force: true });
});

describe('installGitHooks', () => {
  it('writes both hooks as 0755 and is idempotent', async () => {
    const first = await installGitHooks(deps, repo, { command });
    expect(first.status).toBe('installed');
    for (const h of ['pre-commit', 'post-commit']) {
      const p = join(repo, '.git/hooks', h);
      expect(mode(p)).toBe(0o755);
      const text = readFileSync(p, 'utf8');
      expect(text.startsWith('#!/bin/sh\n# agentteams-managed\n')).toBe(true);
      expect(text).toContain(`git-hook ${h} --agentteams-managed`);
    }
    expect((await installGitHooks(deps, repo, { command })).status).toBe('unchanged');
    expect(existsSync(join(repo, '.git/hooks/pre-commit.agentteams-prev'))).toBe(false);
  });

  it('chains an existing user hook, whose failure aborts the commit', async () => {
    const pre = join(repo, '.git/hooks/pre-commit');
    writeFileSync(pre, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    expect((await installGitHooks(deps, repo, { command })).status).toBe('installed');
    expect(readFileSync(`${pre}.agentteams-prev`, 'utf8')).toContain('exit 3');
    expect((await installGitHooks(deps, repo, { command })).status).toBe('unchanged');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    await git(repo, 'add', 'a.txt');
    const r = await realExec('git', ['commit', '-q', '-m', 'x'], { cwd: repo });
    expect(r.code).not.toBe(0); // git itself reports 1 when a hook fails
    expect((await realExec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo })).code).not.toBe(0); // no commit made
    expect((await realExec(pre, [], { cwd: repo })).code).toBe(3); // the hook propagates the prev's code
  });

  it('lets a commit through when the stand-in target exits 0', async () => {
    await installGitHooks(deps, repo, { command });
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    await git(repo, 'add', 'a.txt');
    expect((await realExec('git', ['commit', '-q', '-m', 'x'], { cwd: repo })).code).toBe(0);
  });

  it('refuses when an unmanaged hook and a prev both exist', async () => {
    const hooks = join(repo, '.git/hooks');
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(hooks, 'pre-commit.agentteams-prev'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const r = await installGitHooks(deps, repo, { command });
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('pre-commit and pre-commit.agentteams-prev both exist; merge them manually');
    expect(existsSync(join(hooks, 'post-commit'))).toBe(false);
  });

  it('skips and writes nothing when core.hooksPath is set', async () => {
    await git(repo, 'config', 'core.hooksPath', '.githooks');
    const r = await installGitHooks(deps, repo, { command });
    expect(r.status).toBe('skipped');
    expect(r.detail).toContain('core.hooksPath is set');
    expect(r.detail).toContain('see README → Hook managers');
    expect(existsSync(join(repo, '.git/hooks/pre-commit'))).toBe(false);
    expect(existsSync(join(repo, '.githooks'))).toBe(false);
  });

  it('installs into the common hooks dir from a linked worktree', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    await git(repo, 'add', 'a.txt');
    await git(repo, 'commit', '-q', '-m', 'init');
    const wt = join(tmp, 'wt');
    await git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    expect((await installGitHooks(deps, wt, { command })).status).toBe('installed');
    expect(existsSync(join(repo, '.git/hooks/pre-commit'))).toBe(true);
  });

  it('rewrites a stale managed hook', async () => {
    await installGitHooks(deps, repo, { command });
    const other = join(tmp, 'other.sh');
    writeFileSync(other, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect((await installGitHooks(deps, repo, { command: other })).status).toBe('installed');
    expect(existsSync(join(repo, '.git/hooks/pre-commit.agentteams-prev'))).toBe(false);
    expect(readFileSync(join(repo, '.git/hooks/pre-commit'), 'utf8')).toContain(other);
    expect(readFileSync(join(repo, '.git/hooks/pre-commit'), 'utf8')).not.toContain(standin);
  });

  it('reports a one-line note, and unchanged detail says "already installed"', async () => {
    expect((await installGitHooks(deps, repo, { command })).status).toBe('installed');
    expect((await installGitHooks(deps, repo, { command })).detail).toBe('already installed');
    await git(repo, 'config', 'core.hooksPath', '.githooks');
    expect((await installGitHooks(deps, repo, { command })).detail).not.toMatch(/\n/);
  });

  it('never blocks a commit when the target is missing', async () => {
    await installGitHooks(deps, repo, { command: join(tmp, 'gone.sh') });
    expect((await commitFile()).code).toBe(0);
  });

  it('default node/bin targets are guarded so a missing bin does not block', async () => {
    await installGitHooks(deps, repo);
    const pre = join(repo, '.git/hooks/pre-commit');
    expect(readFileSync(pre, 'utf8')).toMatch(/if \[ -x '.*' \] && \[ -f '.*' \]; then '.*' '.*' git-hook pre-commit/);
    expect(readFileSync(pre, 'utf8').trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('a crashing CLI (exit 1) never blocks a commit', async () => {
    await installGitHooks(deps, repo, { command: mkStandin('crash.sh', 'exit 1') });
    expect((await commitFile()).code).toBe(0);
    expect((await realExec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo })).code).toBe(0);
  });

  it('blocks only when the target exits 3 (the runner\'s "blocked" code)', async () => {
    await installGitHooks(deps, repo, { command: mkStandin('block.sh', 'exit 3') });
    expect((await commitFile()).code).not.toBe(0);
    expect((await realExec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo })).code).not.toBe(0);
  });

  it('warns on stderr and passes when the CLI is missing', async () => {
    const gone = join(tmp, 'gone.sh');
    await installGitHooks(deps, repo, { command: gone });
    const r = await commitFile();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`agentteams: warning: CLI not found at ${gone}; run agentteams install`);
  });

  it('chains a user post-commit hook, moving it to prev', async () => {
    const marker = join(tmp, 'ran');
    const post = join(repo, '.git/hooks/post-commit');
    writeFileSync(post, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await installGitHooks(deps, repo, { command });
    expect(existsSync(`${post}.agentteams-prev`)).toBe(true);
    expect(readFileSync(post, 'utf8')).toContain('# agentteams-managed');
    expect((await commitFile()).code).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it('works when the command path contains a space and a single quote', async () => {
    const dir = join(tmp, "it's a dir");
    mkdirSync(dir);
    const log = join(tmp, 'invoked');
    const odd = join(dir, 'cli.sh');
    writeFileSync(odd, `#!/bin/sh\necho "$@" >> '${log}'\nexit 0\n`, { mode: 0o755 });
    await installGitHooks(deps, repo, { command: odd });
    expect((await commitFile()).code).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('git-hook pre-commit');
  });

  it('restores the user hook if writing the managed one fails', async () => {
    const hooks = join(repo, '.git/hooks');
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    mkdirSync(join(hooks, 'post-commit')); // a directory makes the post-commit write fail
    await expect(installGitHooks(deps, repo, { command })).rejects.toThrow();
    expect(existsSync(join(hooks, 'pre-commit.agentteams-prev'))).toBe(false);
    expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toContain('exit 3');
  });
});
