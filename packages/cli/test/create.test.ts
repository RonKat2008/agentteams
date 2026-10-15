import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type RunningHub } from '@agentteams/hub';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveCredential } from '../src/credentials.js';
import { realExec, type Exec } from '../src/deps.js';
import { main } from '../src/main.js';
import { makeTestCli, type TestCli } from './helpers.js';

const ENV_KEYS = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const saved: Record<string, string | undefined> = {};
const run = (t: TestCli, ...args: string[]) => main(['node', 'agentteams', ...args], t.deps);
const git = async (cwd: string, ...args: string[]) => {
  const r = await realExec('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

interface GhCall { args: string[]; cwd?: string }
/** Real git; scripted gh and claude. */
function scriptedExec(gh: (args: string[]) => { code: number; stdout?: string; stderr?: string }, ghCalls: GhCall[]): Exec {
  return async (cmd, args, opts) => {
    if (cmd === 'gh') {
      ghCalls.push({ args, cwd: opts?.cwd });
      return { code: 0, stdout: '', stderr: '', ...gh(args) };
    }
    if (cmd === 'claude') return { code: 0, stdout: '', stderr: '' };
    return realExec(cmd, args, opts);
  };
}

let hub: RunningHub;
let dbDir: string;
const clis: TestCli[] = [];
const teamBodies: { repo?: { provider: string; slug?: string; defaultBranch: string } }[] = [];
const capturingFetch: typeof fetch = async (input, init) => {
  if (String(input).endsWith('/teams') && init?.method === 'POST' && typeof init.body === 'string') teamBodies.push(JSON.parse(init.body));
  return fetch(input, init);
};
const mk = (exec: Exec): TestCli => {
  const t = makeTestCli({ exec, fetch: capturingFetch });
  clis.push(t);
  return t;
};
const okGh = (args: string[]) => {
  if (args[0] === 'repo' && args[1] === 'view') return { code: 0, stdout: 'me/app\n' };
  return { code: 0 };
};

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'agentteams-create-db-'));
  hub = await startHub({ dbPath: join(dbDir, 'hub.db'), port: 0 });
});
afterAll(async () => {
  await hub.close();
  rmSync(dbDir, { recursive: true, force: true });
  clis.forEach((c) => c.cleanup());
});
beforeEach(() => { for (const [k, v] of Object.entries(ENV_KEYS)) { saved[k] = process.env[k]; process.env[k] = v; } });
afterEach(() => {
  for (const k of Object.keys(ENV_KEYS)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('create --new-repo', () => {
  it('creates the folder, commits, calls gh, registers the team and commits instructions', async () => {
    const ghCalls: GhCall[] = [];
    const t = mk(scriptedExec(okGh, ghCalls));
    expect(await run(t, 'create', 'app', '--hub', hub.url, '--new-repo', '--owner', 'me')).toBe(0);
    const dir = join(t.deps.cwd, 'app');
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# app\n');
    const log = (await git(dir, 'log', '--format=%s')).split('\n');
    expect(log).toEqual(['chore: add agentteams instructions', 'chore: initial commit']);
    const create = ghCalls.find((c) => c.args[0] === 'repo' && c.args[1] === 'create')!;
    expect(create.args).toEqual(['repo', 'create', 'me/app', '--private', '--source', dir, '--push']);
    expect(create.cwd).toBe(dir);
    const cred = await resolveCredential(t.deps, dir, 'claude');
    expect(cred?.repoPath).toBe(realpathSync(dir)); // credentials store the real path
    expect(teamBodies.at(-1)?.repo).toEqual({ provider: 'github', slug: 'me/app', defaultBranch: 'main' });
    expect(t.out.some((l) => l.includes('cd app'))).toBe(true);
    expect(t.err.some((l) => /push/i.test(l))).toBe(true); // no remote: push only warns
  });

  it('passes --public when asked', async () => {
    const ghCalls: GhCall[] = [];
    const t = mk(scriptedExec(okGh, ghCalls));
    expect(await run(t, 'create', 'pub', '--hub', hub.url, '--new-repo', '--public', '--no-install')).toBe(0);
    const create = ghCalls.find((c) => c.args[1] === 'create')!;
    expect(create.args.slice(0, 4)).toEqual(['repo', 'create', 'pub', '--public']);
  });

  it('errors without a folder or team when gh is not authenticated', async () => {
    const t = mk(scriptedExec((a) => (a[0] === 'auth' ? { code: 1, stderr: 'nope' } : { code: 0 }), []));
    expect(await run(t, 'create', 'noauth', '--hub', hub.url, '--new-repo')).toBe(1);
    expect(t.err.join('\n')).toContain('gh is not authenticated; run: gh auth login');
    expect(existsSync(join(t.deps.cwd, 'noauth'))).toBe(false);
  });

  it('errors when gh is missing', async () => {
    const t = mk(scriptedExec((a) => (a[0] === 'auth' ? { code: 127 } : { code: 0 }), []));
    expect(await run(t, 'create', 'nogh', '--hub', hub.url, '--new-repo')).toBe(1);
    expect(t.err.join('\n')).toContain('gh (GitHub CLI) is required for --new-repo');
  });

  it('errors when the target folder is non-empty', async () => {
    const t = mk(scriptedExec(okGh, []));
    mkdirSync(join(t.deps.cwd, 'app'));
    writeFileSync(join(t.deps.cwd, 'app', 'x.txt'), 'x');
    expect(await run(t, 'create', 'app', '--hub', hub.url, '--new-repo')).toBe(1);
    expect(t.err.join('\n')).toMatch(/not empty/);
  });

  it('keeps the local folder and reports gh stderr when repo create fails', async () => {
    const t = mk(scriptedExec((a) => (a[1] === 'create' ? { code: 1, stderr: 'name taken' } : { code: 0 }), []));
    expect(await run(t, 'create', 'dup', '--hub', hub.url, '--new-repo', '--no-install')).toBe(1);
    const msg = t.err.join('\n');
    expect(msg).toContain('name taken');
    expect(msg).toMatch(/kept/);
    expect(existsSync(join(t.deps.cwd, 'dup', '.git'))).toBe(true);
  });

  it('conflicts with --repo and --local', async () => {
    const t = mk(scriptedExec(okGh, []));
    expect(await run(t, 'create', 'a', '--hub', hub.url, '--new-repo', '--repo', 'o/n')).toBe(1);
    expect(await run(t, 'create', 'a', '--hub', hub.url, '--new-repo', '--local')).toBe(1);
    expect(existsSync(join(t.deps.cwd, 'a'))).toBe(false);
  });
});

describe('create in an existing repo', () => {
  const setup = async (t: TestCli) => {
    await git(t.deps.cwd, 'init', '-q', '-b', 'trunk');
    await git(t.deps.cwd, 'remote', 'add', 'origin', 'git@github.com:me/old.git');
    await git(t.deps.cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  };

  it('uses the detected default branch', async () => {
    const t = mk(scriptedExec(okGh, []));
    await setup(t);
    expect(await run(t, 'create', 'trunky', '--hub', hub.url, '--no-install')).toBe(0);
    expect(teamBodies.at(-1)?.repo).toEqual({ provider: 'github', slug: 'me/old', defaultBranch: 'trunk' });
  });

  it('warns but continues when gh cannot verify access', async () => {
    const t = mk(scriptedExec((a) => (a[1] === 'view' ? { code: 1, stderr: 'Could not resolve\nmore' } : { code: 0 }), []));
    await setup(t);
    expect(await run(t, 'create', 'unverified', '--hub', hub.url, '--no-install')).toBe(0);
    expect(t.err).toContain('warning: could not verify access to me/old with gh (Could not resolve)');
  });
});
