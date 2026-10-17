import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveCredential } from '../src/credentials.js';
import { realExec, type Exec } from '../src/deps.js';
import { LocalTeamClient } from '../src/local/localClient.js';
import { openTeamStore } from '../src/local/store.js';
import { main } from '../src/main.js';
import { makeTestCli, type TestCli } from './helpers.js';
import { git, gitDeps, makeRepo, seedTeam, type Seeded, type TempRepo } from './localHelpers.js';

// Each case makes several real git worktrees and merges.
vi.setConfig({ testTimeout: 30_000 });

let r: TempRepo;
let s: Seeded;
let cli: TestCli;
let alice: LocalTeamClient;
let bob: LocalTeamClient;

/** Real git and sh (the --test command); every other tool succeeds without running. */
const exec: Exec = async (cmd, args, opts) =>
  (cmd === 'git' || cmd === 'sh' ? realExec(cmd, args, { ...opts, env: { ...opts?.env, ...GIT_ID } }) : { code: 0, stdout: '', stderr: '' });
const GIT_ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

const run = (...args: string[]) => main(['node', 'agentteams', ...args], cli.deps);
const out = () => cli.out.join('\n');
const integrationDir = () => join(r.repo, '.agentteams', 'worktrees', '_merge');

/** A task assigned to bob, finished on its own branch with `files` committed. Returns the task number. */
async function finishedTask(title: string, files: Record<string, string>): Promise<number> {
  const { ctx, core } = await openTeamStore(gitDeps, r.repo);
  const actor = await core.authenticate(ctx, s.alice.apiKey);
  const { createTask } = await import('../../hub/src/services/tasks.js');
  const n = (await createTask(ctx, actor, { title, description: '', assignee: s.bob.agentName })).number;
  const branch = `at/${s.bob.agentName}/${n}`;
  const wt = join(r.root, `wt-${n}`);
  git(r.repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  for (const [f, text] of Object.entries(files)) writeFileSync(join(wt, f), text);
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', title);
  git(r.repo, 'worktree', 'remove', wt);
  await bob.claimTask(n);
  await bob.completeTask(n, `did ${title}`, branch);
  return n;
}

const mergedTasks = async () => (await alice.listTasks()).filter((t) => t.mergedAt).map((t) => t.number);
const mainFile = (f: string) => git(r.repo, 'show', `main:${f}`);

beforeEach(async () => {
  r = makeRepo();
  s = await seedTeam(r.repo);
  alice = new LocalTeamClient(gitDeps, s.alice);
  bob = new LocalTeamClient(gitDeps, s.bob);
  cli = makeTestCli({ exec, cwd: r.repo, homedir: join(r.root, 'home') });
  await saveCredential(cli.deps, s.alice);
  await saveCredential(cli.deps, s.bob);
});
afterEach(() => { cli.cleanup(); r.cleanup(); });

describe('agentteams merge', () => {
  it('merges every finished task, runs the tests, fast-forwards the base and records the merges', async () => {
    const t1 = await finishedTask('Login', { 'login.txt': 'login\n' });
    const t2 = await finishedTask('Signup', { 'signup.txt': 'signup\n' });
    const before = git(r.repo, 'rev-parse', 'main');

    expect(await run('merge', '--test', 'echo all-tests-ok')).toBe(0);

    expect(mainFile('login.txt')).toBe('login');
    expect(mainFile('signup.txt')).toBe('signup');
    expect(git(r.repo, 'rev-list', '--count', `${before}..main`)).toBe('4'); // two task commits + two --no-ff merges
    expect(readFileSync(join(r.repo, 'signup.txt'), 'utf8')).toBe('signup\n'); // checkout moved too
    expect(await mergedTasks()).toEqual([t1, t2]);
    const events = (await alice.activity({ limit: 50 })).filter((e) => e.type === 'merged');
    expect(events).toHaveLength(2);
    expect(out()).toContain('all-tests-ok');
    expect(out()).toMatch(/Tests passed/);
    expect(existsSync(integrationDir())).toBe(false);
    expect(git(r.repo, 'worktree', 'list')).not.toContain('_merge');
    expect(cli.calls.some((c) => c.cmd === 'git' && c.args[0] === 'push')).toBe(false);
  });

  it('skips a conflicting task, merges the others, and asks its agent to rebase', async () => {
    const t1 = await finishedTask('Edit A one way', { 'a.txt': 'one\n' });
    const t2 = await finishedTask('Edit A another way', { 'a.txt': 'two\n' });
    const t3 = await finishedTask('Add C', { 'c.txt': 'c\n' });

    expect(await run('merge', '--test', 'exit 0')).toBe(1);

    expect(mainFile('a.txt')).toBe('one');
    expect(mainFile('c.txt')).toBe('c');
    expect(await mergedTasks()).toEqual([t1, t3]);
    expect(out()).toMatch(new RegExp(`#${t2}.*conflict.*#${t1}.*a\\.txt`, 'i'));
    const inbox = (await bob.ping(false)).messages.filter((m) => m.kind === 'command' && /merged into/.test(m.body));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.body).toMatch(new RegExp(`#${t2}`));
    expect(inbox[0]!.body).toMatch(/rebase/i);
    expect(inbox[0]!.body).toContain('a.txt');
  });

  it('--no-notify sends no message', async () => {
    await finishedTask('Edit A one way', { 'a.txt': 'one\n' });
    await finishedTask('Edit A another way', { 'a.txt': 'two\n' });
    expect(await run('merge', '--test', 'exit 0', '--no-notify')).toBe(1);
    expect((await bob.ping(false)).messages.filter((m) => /rebase/i.test(m.body))).toHaveLength(0);
  });

  it('--stop-on-conflict stops at the conflict, lands nothing and keeps the conflicted worktree', async () => {
    await finishedTask('Edit A one way', { 'a.txt': 'one\n' });
    await finishedTask('Edit A another way', { 'a.txt': 'two\n' });
    await finishedTask('Add C', { 'c.txt': 'c\n' });
    const before = git(r.repo, 'rev-parse', 'main');

    expect(await run('merge', '--test', 'exit 0', '--stop-on-conflict', '--no-notify')).toBe(1);

    expect(git(r.repo, 'rev-parse', 'main')).toBe(before);
    expect(await mergedTasks()).toEqual([]);
    expect(git(integrationDir(), 'diff', '--name-only', '--diff-filter=U')).toBe('a.txt');
    expect(existsSync(join(integrationDir(), 'c.txt'))).toBe(false);
    expect(out()).toContain(integrationDir());
  });

  it('failing tests leave the base untouched, mark nothing and keep the integration worktree', async () => {
    await finishedTask('Login', { 'login.txt': 'login\n' });
    const before = git(r.repo, 'rev-parse', 'main');

    expect(await run('merge', '--test', 'echo boom-failure; exit 3')).toBe(1);

    expect(git(r.repo, 'rev-parse', 'main')).toBe(before);
    expect(await mergedTasks()).toEqual([]);
    expect(existsSync(join(integrationDir(), 'login.txt'))).toBe(true);
    expect(out()).toContain('boom-failure');
    expect(out()).toMatch(/Tests failed/);
    expect(out()).toContain(integrationDir());
  });

  it('a later run replaces a kept integration worktree', async () => {
    await finishedTask('Login', { 'login.txt': 'login\n' });
    expect(await run('merge', '--test', 'exit 1')).toBe(1);
    expect(existsSync(integrationDir())).toBe(true);
    expect(await run('merge', '--test', 'exit 0')).toBe(0);
    expect(mainFile('login.txt')).toBe('login');
  });

  it('--dry-run merges and tests without touching the base or recording anything', async () => {
    await finishedTask('Login', { 'login.txt': 'login\n' });
    const before = git(r.repo, 'rev-parse', 'main');

    expect(await run('merge', '--test', 'exit 0', '--dry-run')).toBe(0);

    expect(git(r.repo, 'rev-parse', 'main')).toBe(before);
    expect(await mergedTasks()).toEqual([]);
    expect(out()).toMatch(/dry run/i);
    expect(existsSync(integrationDir())).toBe(false);
  });

  it('--no-test skips the tests; with no test command found it says so and still merges', async () => {
    await finishedTask('Login', { 'login.txt': 'login\n' });
    expect(await run('merge', '--no-test')).toBe(0);
    expect(out()).toMatch(/skipping tests/i);
    expect(mainFile('login.txt')).toBe('login');

    await finishedTask('Signup', { 'signup.txt': 'signup\n' });
    cli.out.length = 0;
    expect(await run('merge')).toBe(0);
    expect(out()).toMatch(/no test command found/i);
  });

  it('prints the auto-detected test command', async () => {
    writeFileSync(join(r.repo, 'Makefile'), 'test:\n\t@echo make-tests-ran\n');
    git(r.repo, 'add', 'Makefile');
    git(r.repo, 'commit', '-q', '-m', 'makefile');
    await finishedTask('Login', { 'login.txt': 'login\n' });
    // `make` may not be installed: answer the detected command without running it.
    cli.deps.exec = async (cmd, args, opts) => (cmd === 'sh' && args[1] === 'make test' ? { code: 0, stdout: 'make-tests-ran\n', stderr: '' } : exec(cmd, args, opts));
    expect(await run('merge')).toBe(0);
    expect(out()).toMatch(/Tests: make test \(from Makefile\)/);
  });

  it('only the orchestrator may merge', async () => {
    await finishedTask('Login', { 'login.txt': 'login\n' });
    expect(await run('merge', '--agent', 'codex', '--test', 'exit 0')).toBe(1);
    expect(cli.err.join('\n')).toMatch(/only the orchestrator \(alice-claude\) can merge tasks/);
    expect(existsSync(integrationDir())).toBe(false);
  });

  it('says so when there is nothing to merge', async () => {
    expect(await run('merge', '--test', 'exit 0')).toBe(0);
    expect(out()).toMatch(/no finished tasks to merge/i);
  });

  it('a dirty base checkout is not touched: the integration branch is kept with the command to land it', async () => {
    const t1 = await finishedTask('Login', { 'login.txt': 'login\n' });
    writeFileSync(join(r.repo, 'a.txt'), 'local edit\n');
    const before = git(r.repo, 'rev-parse', 'main');

    expect(await run('merge', '--test', 'exit 0')).toBe(1);

    expect(git(r.repo, 'rev-parse', 'main')).toBe(before);
    expect(readFileSync(join(r.repo, 'a.txt'), 'utf8')).toBe('local edit\n');
    expect(await mergedTasks()).toEqual([]);
    expect(out()).toMatch(/uncommitted changes/);
    expect(out()).toContain('git merge --ff-only agentteams/merge');
    expect(out()).toContain(`agentteams merged ${t1}`);
    expect(git(r.repo, 'rev-parse', 'agentteams/merge')).not.toBe(before);
  });

  it('--into a branch that is not checked out keeps the integration branch and prints the command', async () => {
    git(r.repo, 'branch', 'release');
    await finishedTask('Login', { 'login.txt': 'login\n' });
    expect(await run('merge', '--test', 'exit 0', '--into', 'release')).toBe(1);
    expect(out()).toContain('git checkout release && git merge --ff-only agentteams/merge');
    expect(await mergedTasks()).toEqual([]);
  });

  it('refuses a base branch with no commits', async () => {
    git(r.repo, 'checkout', '-q', '--orphan', 'fresh');
    await finishedTask('Login', { 'login.txt': 'login\n' });
    expect(await run('merge', '--test', 'exit 0')).toBe(1);
    expect(cli.err.join('\n')).toMatch(/fresh has no commits/);
    expect(await run('merge', '--test', 'exit 0', '--into', 'nope')).toBe(1);
    expect(cli.err.join('\n')).toMatch(/branch nope does not exist/);
  });

  it('fetches task branches that exist only on the remote', async () => {
    const remote = join(r.root, 'remote.git');
    git(r.root, 'init', '-q', '--bare', remote);
    git(r.repo, 'remote', 'add', 'origin', remote);
    git(r.repo, 'push', '-q', 'origin', 'main');
    const t1 = await finishedTask('Login', { 'login.txt': 'login\n' });
    const branch = `at/${s.bob.agentName}/${t1}`;
    git(r.repo, 'push', '-q', 'origin', branch);
    git(r.repo, 'branch', '-D', branch);
    git(r.repo, 'update-ref', '-d', `refs/remotes/origin/${branch}`);

    expect(await run('merge', '--test', 'exit 0')).toBe(0);
    expect(mainFile('login.txt')).toBe('login');
    expect(git(remote, 'rev-parse', 'main')).not.toBe(git(r.repo, 'rev-parse', 'main')); // no --push
  });

  it('--push pushes the base after landing', async () => {
    const remote = join(r.root, 'remote.git');
    git(r.root, 'init', '-q', '--bare', remote);
    git(r.repo, 'remote', 'add', 'origin', remote);
    git(r.repo, 'push', '-q', 'origin', 'main');
    await finishedTask('Login', { 'login.txt': 'login\n' });
    expect(await run('merge', '--test', 'exit 0', '--push')).toBe(0);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(r.repo, 'rev-parse', 'main'));
  });

  it('skips a task whose branch is missing', async () => {
    const t1 = await finishedTask('Login', { 'login.txt': 'login\n' });
    git(r.repo, 'branch', '-D', `at/${s.bob.agentName}/${t1}`);
    expect(await run('merge', '--test', 'exit 0')).toBe(1);
    expect(out()).toMatch(new RegExp(`#${t1}.*branch .* not found`));
    expect(await mergedTasks()).toEqual([]);
  });

  it('keeps the integration worktree git-excluded', async () => {
    await finishedTask('Login', { 'login.txt': 'login\n' });
    expect(await run('merge', '--test', 'exit 1')).toBe(1);
    expect(readFileSync(join(r.repo, '.git', 'info', 'exclude'), 'utf8')).toMatch(/^\.agentteams\/$/m);
    expect(git(r.repo, 'status', '--porcelain')).toBe('');
  });
});
