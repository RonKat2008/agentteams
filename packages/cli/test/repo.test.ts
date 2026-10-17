import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { realExec, type Exec } from '../src/deps.js';
import { checkTeamDir, detectGithubSlug, ensureFirstCommit, FIRST_COMMIT_MESSAGE, repoRoot } from '../src/repo.js';
import { defaultMemberName } from '@agentteams/shared';
import { fakeExec } from './helpers.js';

describe('repo helpers', () => {
  it('finds the git toplevel, falling back to cwd', async () => {
    expect(await repoRoot({ exec: fakeExec({ 'git rev-parse --show-toplevel': { stdout: '/w/app\n' } }) }, '/w/app/src')).toBe('/w/app');
    expect(await repoRoot({ exec: fakeExec({}) }, '/not/git')).toBe('/not/git');
  });

  it.each([
    ['https://github.com/ronit/my-app.git', 'ronit/my-app'],
    ['https://github.com/ronit/my-app', 'ronit/my-app'],
    ['git@github.com:ronit/my-app.git', 'ronit/my-app'],
    ['ssh://git@github.com/ronit/my.app.git', 'ronit/my.app'],
  ])('parses %s', async (url, slug) => {
    const exec = fakeExec({ 'git remote get-url origin': { stdout: `${url}\n` } });
    expect(await detectGithubSlug({ exec }, '/w')).toBe(slug);
  });

  it('returns null for non-GitHub or missing origins', async () => {
    expect(await detectGithubSlug({ exec: fakeExec({ 'git remote get-url origin': { stdout: 'https://gitlab.com/a/b.git' } }) }, '/w')).toBeNull();
    expect(await detectGithubSlug({ exec: fakeExec({}) }, '/w')).toBeNull();
  });

  it('sanitises OS usernames into member names', () => {
    expect(defaultMemberName('Ronit K')).toBe('ronit_k');
    expect(defaultMemberName('a.very-long.user.name.exceeding.limit')).toBe('a_very_long_user_name_ex');
    expect(defaultMemberName('!!!')).toBe('___');
    expect(defaultMemberName('')).toBe('user');
  });
});

describe('checkTeamDir', () => {
  const git = fakeExec({ 'git rev-parse --show-toplevel': { stdout: '/w/app\n' } });
  it('refuses the home directory and the filesystem root', async () => {
    const err: string[] = [];
    const deps = { exec: git, homedir: '/Users/x', err: (l: string) => err.push(l) };
    await expect(checkTeamDir(deps, '/Users/x')).rejects.toThrow(/refusing to set up a team in \/Users\/x/);
    await expect(checkTeamDir(deps, '/')).rejects.toThrow(/refusing/);
  });
  it('warns outside a git repo but proceeds', async () => {
    const err: string[] = [];
    await checkTeamDir({ exec: fakeExec({}), homedir: '/Users/x', err: (l) => err.push(l) }, '/tmp');
    expect(err.join('\n')).toContain('is not a git repository');
  });
  it('is silent inside a git repo', async () => {
    const err: string[] = [];
    await checkTeamDir({ exec: git, homedir: '/Users/x', err: (l) => err.push(l) }, '/w/app');
    expect(err).toEqual([]);
  });
});

describe('ensureFirstCommit', () => {
  const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const exec: Exec = (cmd, args, opts) => realExec(cmd, args, { ...opts, env: { ...opts?.env, ...ID } });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentteams-first-')));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'user.email', 't@example.com');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('makes an empty first commit that leaves staged files staged and out of the commit', async () => {
    writeFileSync(join(dir, 'secret.txt'), 'mine');
    git(dir, 'add', 'secret.txt');
    expect(await ensureFirstCommit({ exec }, dir)).toBe('committed');
    expect(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe('');
    expect(git(dir, 'log', '--format=%s')).toBe(FIRST_COMMIT_MESSAGE);
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('secret.txt');
  });

  it('does nothing when HEAD already has a commit', async () => {
    expect(await ensureFirstCommit({ exec }, dir)).toBe('committed');
    expect(await ensureFirstCommit({ exec }, dir)).toBe('exists');
  });
});
