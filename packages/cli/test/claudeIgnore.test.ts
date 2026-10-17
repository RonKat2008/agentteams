import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Credential } from '../src/credentials.js';
import { realExec, type Exec } from '../src/deps.js';
import { gitPath } from '../src/git.js';
import { installClaude, installClaudeForWorktree } from '../src/install/claude.js';
import { makeTestCli, type TestCli } from './helpers.js';
import { git, makeRepo, type TempRepo } from './localHelpers.js';

const ARGV = { command: '/usr/bin/node', args: ['/opt/x/dist/bin.js'] };
const SETTINGS = '.claude/settings.local.json';

/** Real git; `claude mcp add` answers success without running. */
const exec: Exec = async (cmd, args, opts) => (cmd === 'git' ? realExec(cmd, args, opts) : { code: 0, stdout: '', stderr: '' });
const ignored = (cwd: string, rel: string): boolean => {
  try { execFileSync('git', ['check-ignore', '-q', rel], { cwd }); return true; } catch { return false; }
};

let r: TempRepo;
let t: TestCli;
let cred: Credential;
const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, xdg: process.env.XDG_CONFIG_HOME };
beforeEach(() => {
  // Claude Code may have put the file in this machine's global ignore: the test must not depend on that.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.XDG_CONFIG_HOME = '/nonexistent';
  r = makeRepo();
  t = makeTestCli({ exec, cwd: r.repo });
  cred = { repoPath: r.repo, tool: 'claude', hubUrl: '', teamName: 'dev', agentName: 'ana-claude', apiKey: 'at_SECRET', createdAt: 'x' };
});
afterEach(() => {
  t.cleanup(); r.cleanup();
  for (const [k, v] of [['GIT_CONFIG_GLOBAL', savedEnv.global], ['XDG_CONFIG_HOME', savedEnv.xdg]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('.claude/settings.local.json stays out of git (real git)', () => {
  it('is ignored after install, once, without touching a tracked .gitignore', async () => {
    writeFileSync(join(r.repo, '.gitignore'), 'node_modules\n');
    await installClaude(t.deps, cred, { cli: 'agentteams', argv: ARGV });
    await installClaude(t.deps, cred, { cli: 'agentteams', argv: ARGV });
    expect(ignored(r.repo, SETTINGS)).toBe(true);
    expect(git(r.repo, 'status', '--porcelain', '--', '.claude')).toBe('');
    expect(git(r.repo, 'diff', '--stat', '--', '.gitignore')).toBe('');
  });

  it('is ignored in a linked worktree too', async () => {
    const wt = join(r.root, 'wt');
    git(r.repo, 'worktree', 'add', '-q', wt, '-b', 'feature');
    await installClaudeForWorktree(t.deps, cred, wt, { cli: 'agentteams', argv: ARGV });
    expect(ignored(wt, SETTINGS)).toBe(true);
  });

  it('warns when the file is already tracked (ignore rules cannot hide it)', async () => {
    mkdirSync(join(r.repo, '.claude'));
    writeFileSync(join(r.repo, SETTINGS), '{}\n');
    git(r.repo, 'add', '-f', SETTINGS);
    git(r.repo, 'commit', '-q', '-m', 'oops');
    const report = await installClaude(t.deps, cred, { cli: 'agentteams', argv: ARGV });
    expect(report.warnings.join('\n')).toMatch(/\.claude\/settings\.local\.json is tracked by git.*git rm --cached/s);
  });

  it('still finds the exclude file when git is too old for --path-format', async () => {
    const old: Exec = async (cmd, args, opts) =>
      args.includes('--path-format=absolute') ? { code: 129, stdout: '', stderr: 'unknown option' } : exec(cmd, args, opts);
    const path = await gitPath({ exec: old }, r.repo, 'info/exclude');
    expect(path).toBe(join(r.repo, '.git', 'info', 'exclude'));
  });
});
