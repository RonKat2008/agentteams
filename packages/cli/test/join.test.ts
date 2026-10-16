import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type RunningHub } from '@agentteams/hub';
import type { RepoLink } from '@agentteams/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { realExec, type Exec } from '../src/deps.js';
import { HubClient } from '../src/hubClient.js';
import { main } from '../src/main.js';
import { makeTestCli, type TestCli } from './helpers.js';

const ENV_KEYS = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const saved: Record<string, string | undefined> = {};
const run = (t: TestCli, ...args: string[]) => main(['node', 'agentteams', ...args], t.deps);

interface Call { cmd: string; args: string[] }
type Mode = 'gh-ok' | 'gh-missing' | 'gh-fail' | 'git-clone-fail';
/** Real git; a fake clone that creates the target with `git init` + origin; gh/claude scripted. Never touches the network. */
function cloneExec(mode: Mode, calls: Call[]): Exec {
  const fakeClone = async (slug: string, target: string) => {
    mkdirSync(target, { recursive: true });
    await realExec('git', ['init', '-q'], { cwd: target });
    await realExec('git', ['remote', 'add', 'origin', `https://github.com/${slug}.git`], { cwd: target });
    return { code: 0, stdout: '', stderr: '' };
  };
  return async (cmd, args, opts) => {
    if (cmd === 'claude') return { code: 0, stdout: '', stderr: '' };
    if (cmd === 'gh') {
      calls.push({ cmd, args });
      if (mode === 'gh-missing' || mode === 'git-clone-fail') return { code: 127, stdout: '', stderr: 'command not found: gh' };
      if (mode === 'gh-fail') return { code: 1, stdout: '', stderr: 'HTTP 404: Not Found\nmore' };
      if (args[0] === 'repo' && args[1] === 'clone') return fakeClone(args[2]!, args[3]!);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'git' && args[0] === 'clone') {
      calls.push({ cmd, args });
      if (mode === 'git-clone-fail') return { code: 128, stdout: '', stderr: 'fatal: repository not found' };
      return fakeClone(args[1]!.replace('https://github.com/', '').replace(/\.git$/, ''), args[2]!);
    }
    return realExec(cmd, args, opts);
  };
}

let hub: RunningHub;
let dbDir: string;
let n = 0;
const clis: TestCli[] = [];
const mk = (exec: Exec): TestCli => { const t = makeTestCli({ exec }); clis.push(t); return t; };
const github: RepoLink = { provider: 'github', slug: 'me/app', defaultBranch: 'main' };
async function team(repo: RepoLink): Promise<{ code: string; id: string }> {
  const r = await new HubClient(hub.url).createTeam({ name: `jt${++n}`, member: 'owner', tool: 'claude', repo });
  return { code: r.inviteCode, id: r.teamId };
}
beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'agentteams-join-db-'));
  hub = await startHub({ dbPath: join(dbDir, 'hub.db'), port: 0 });
});
afterAll(async () => { await hub.close(); rmSync(dbDir, { recursive: true, force: true }); clis.forEach((c) => c.cleanup()); });
beforeEach(() => { for (const [k, v] of Object.entries(ENV_KEYS)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterEach(() => { for (const k of Object.keys(ENV_KEYS)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const credRepoPath = async (t: TestCli, dir = t.deps.cwd): Promise<string | undefined> => {
  const { resolveCredential } = await import('../src/credentials.js');
  return (await resolveCredential(t.deps, dir, 'claude'))?.repoPath;
};

describe('join with preview and clone', () => {
  it('uses cwd without cloning when it is already a clone of the team repo', async () => {
    const calls: Call[] = [];
    const t = mk(cloneExec('gh-ok', calls));
    await realExec('git', ['init', '-q'], { cwd: t.deps.cwd });
    await realExec('git', ['remote', 'add', 'origin', 'git@github.com:Me/App.git'], { cwd: t.deps.cwd });
    const { code } = await team(github);
    expect(await run(t, 'join', code, '--hub', hub.url, '--no-install')).toBe(0);
    expect(calls).toEqual([]);
    expect(await credRepoPath(t)).toBe(realpathSync(t.deps.cwd));
  });

  it('clones with gh into <cwd>/<repo name> and uses it as repoPath', async () => {
    const calls: Call[] = [];
    const t = mk(cloneExec('gh-ok', calls));
    const { code } = await team(github);
    expect(await run(t, 'join', code, '--hub', hub.url, '--no-install')).toBe(0);
    const target = join(t.deps.cwd, 'app');
    expect(calls).toEqual([{ cmd: 'gh', args: ['repo', 'clone', 'me/app', target] }]);
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(await credRepoPath(t, target)).toBe(realpathSync(target));
    expect(t.out.join('\n')).toMatch(/Joined team ".+" as .+\. Repo: /);
  });

  it('honors --dir as the clone target', async () => {
    const calls: Call[] = [];
    const t = mk(cloneExec('gh-ok', calls));
    const dir = join(t.root, 'elsewhere');
    const { code } = await team(github);
    expect(await run(t, 'join', code, '--hub', hub.url, '--no-install', '--dir', dir)).toBe(0);
    expect(calls[0]!.args[3]).toBe(dir);
    expect(await credRepoPath(t, dir)).toBe(realpathSync(dir));
  });

  it('reuses an existing target that is a clone of the slug', async () => {
    const calls: Call[] = [];
    const t = mk(cloneExec('gh-ok', calls));
    const target = join(t.deps.cwd, 'app');
    mkdirSync(target);
    await realExec('git', ['init', '-q'], { cwd: target });
    await realExec('git', ['remote', 'add', 'origin', 'https://github.com/me/app.git'], { cwd: target });
    const { code } = await team(github);
    expect(await run(t, 'join', code, '--hub', hub.url, '--no-install')).toBe(0);
    expect(calls).toEqual([]);
    expect(await credRepoPath(t, target)).toBe(realpathSync(target));
  });

  it('errors without joining when the target is a different repo', async () => {
    const calls: Call[] = [];
    const t = mk(cloneExec('gh-ok', calls));
    const target = join(t.deps.cwd, 'app');
    mkdirSync(target);
    await realExec('git', ['init', '-q'], { cwd: target });
    await realExec('git', ['remote', 'add', 'origin', 'https://github.com/other/app.git'], { cwd: target });
    const { code } = await team(github);
    expect(await run(t, 'join', code, '--hub', hub.url, '--no-install')).toBe(1);
    expect(t.err.join('\n')).toContain(`${target} already exists and is not a clone of me/app; pass --dir <path>`);
    expect(calls).toEqual([]);
    expect(await credRepoPath(t)).toBeUndefined();
    // the invite still works for a later, correct join
    const t2 = mk(cloneExec('gh-ok', []));
    expect(await run(t2, 'join', code, '--hub', hub.url, '--no-install', '--as', 'later')).toBe(0);
  });

  it('errors mentioning access on clone failure and creates no agent', async () => {
    const t = mk(cloneExec('gh-fail', []));
    const { code } = await team(github);
    expect(await run(t, 'join', code, '--hub', hub.url, '--no-install')).toBe(1);
    expect(t.err.join('\n')).toContain(
      'could not clone me/app (HTTP 404: Not Found). Ask the team creator to give you access to the GitHub repo, then re-run this command.');
    expect(await credRepoPath(t)).toBeUndefined();
    // no agent was created: the same member name is still free
    const t2 = mk(cloneExec('gh-ok', []));
    expect(await run(t2, 'join', code, '--hub', hub.url, '--no-install', '--as', 'someone')).toBe(0);
    expect(t2.out.join('\n')).toContain('as someone-claude');
  });

  it('falls back to git clone when gh is missing', async () => {
    const calls: Call[] = [];
    const t = mk(cloneExec('gh-missing', calls));
    const { code } = await team(github);
    expect(await run(t, 'join', code, '--hub', hub.url, '--no-install')).toBe(0);
    const target = join(t.deps.cwd, 'app');
    expect(calls.at(-1)).toEqual({ cmd: 'git', args: ['clone', 'https://github.com/me/app.git', target] });
    expect(existsSync(join(target, '.git'))).toBe(true);
  });

  it('reports git clone failures after the gh fallback', async () => {
    const t = mk(cloneExec('git-clone-fail', []));
    const { code } = await team(github);
    expect(await run(t, 'join', code, '--hub', hub.url, '--no-install')).toBe(1);
    expect(t.err.join('\n')).toContain('could not clone me/app (fatal: repository not found)');
  });

  it('--no-clone warns about the mismatch and uses cwd', async () => {
    const calls: Call[] = [];
    const t = mk(cloneExec('gh-ok', calls));
    const { code } = await team(github);
    expect(await run(t, 'join', code, '--hub', hub.url, '--no-install', '--no-clone')).toBe(0);
    expect(calls).toEqual([]);
    expect(t.err.join('\n')).toContain('warning: this team is linked to me/app');
  });

  it('does not clone for a local team', async () => {
    const calls: Call[] = [];
    const t = mk(cloneExec('gh-ok', calls));
    const { code } = await team({ provider: 'local', defaultBranch: 'main' });
    expect(await run(t, 'join', code, '--hub', hub.url, '--no-install')).toBe(0);
    expect(calls).toEqual([]);
  });

  it('shows the preview error for an expired or bogus invite and clones nothing', async () => {
    const calls: Call[] = [];
    const t = mk(cloneExec('gh-ok', calls));
    expect(await run(t, 'join', 'aaaa-bbbb-cccc-dddd', '--hub', hub.url, '--no-install')).toBe(1);
    expect(t.err.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
    expect(existsSync(join(t.deps.cwd, 'app'))).toBe(false);
  });

  it.each(['../evil/app', 'me/..', 'a b/app', 'me/app/extra', '-x/app'])('rejects the untrusted slug %s', async (slug) => {
    const calls: Call[] = [];
    const t = mk(cloneExec('gh-ok', calls));
    const { code } = await team({ provider: 'github', slug, defaultBranch: 'main' }).catch(() => ({ code: '' }));
    if (!code) return; // the hub already refuses this slug
    expect(await run(t, 'join', code, '--hub', hub.url, '--no-install')).toBe(1);
    expect(calls).toEqual([]);
    expect(t.err.join('\n')).toMatch(/repo slug is invalid/);
  });

  it('refuses to clone into the home directory', async () => {
    const t = mk(cloneExec('gh-ok', []));
    const { code } = await team(github);
    expect(await run(t, 'join', code, '--hub', hub.url, '--no-install', '--dir', t.deps.homedir)).toBe(1);
    expect(t.err.join('\n')).toContain('refusing to set up a team');
  });
});
