import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHub } from '@agentteams/hub';
import { saveCredential } from '../src/credentials.js';
import { realExec } from '../src/deps.js';
import { HubClient } from '../src/hubClient.js';
import { installGitHooks } from '../src/install/gitHooks.js';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const built = existsSync(BIN);
if (!built) console.warn(`e2e.gitHooksBin.test: ${BIN} missing; run "pnpm -r build" first (test skipped)`);

let tmp: string;
let repo: string;
let home: string;
let hub: Awaited<ReturnType<typeof startHub>>;
let ashKey: string;
let ronitKey: string;

const baseEnv = (): NodeJS.ProcessEnv => ({
  ...process.env, AGENTTEAMS_HOME: join(home, '.at'), AGENTTEAMS_ALLOW: undefined,
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
});
const git = async (env: NodeJS.ProcessEnv, ...args: string[]) => {
  try {
    const r = await run('git', args, { cwd: repo, env });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, stdout: x.stdout, stderr: x.stderr };
  }
};
const stageFile = async (f: string) => {
  mkdirSync(join(repo, f, '..'), { recursive: true });
  writeFileSync(join(repo, f), `${f}\n${Math.random()}\n`);
  expect((await git(baseEnv(), 'add', f)).code).toBe(0);
};
const changes = async () => {
  const res = await fetch(`${hub.url}/api/team/changes`, { headers: { authorization: `Bearer ${ashKey}` } });
  return (await res.json()) as { files: string[]; agent: string }[];
};

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'at-binhooks-')));
  repo = join(tmp, 'repo');
  home = join(tmp, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  hub = await startHub({ dbPath: join(tmp, 'hub.db'), port: 0 });
  if (!built) return;
  expect((await git(baseEnv(), 'init', '-q', '-b', 'main')).code).toBe(0);
  const anon = new HubClient(hub.url);
  const created = await anon.createTeam({ name: 'dev', member: 'ronit', tool: 'claude', repo: { provider: 'local' } });
  const ash = await anon.joinTeam({ inviteCode: created.inviteCode, member: 'ash', tool: 'codex' });
  ronitKey = created.apiKey;
  ashKey = ash.apiKey;
  await saveCredential({ env: baseEnv(), homedir: home }, {
    repoPath: repo, tool: 'claude', hubUrl: hub.url, teamName: 'dev', agentName: created.agentName,
    apiKey: ronitKey, createdAt: new Date().toISOString(),
  });
  // dist/bin.js is executable with a node shebang, so it serves as the single-executable hook target.
  expect((await installGitHooks({ exec: realExec }, repo, { command: BIN })).status).toBe('installed');
});
afterEach(async () => {
  await hub.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!built)('managed git hooks driving the built CLI', () => {
  const claimAsAsh = async () => {
    const res = await fetch(`${hub.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${ashKey}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'claim_files', arguments: { globs: ['src/**'], exclusive: true } } }),
    });
    expect(res.status).toBe(200);
  };

  it('blocks a claimed file, honours AGENTTEAMS_ALLOW=1, and records the commit in the hub', async () => {
    await claimAsAsh();
    await stageFile('src/a.ts');

    const blocked = await git(baseEnv(), 'commit', '-q', '-m', 'blocked');
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain('commit blocked');
    expect(blocked.stderr).toContain('ash-codex');
    expect((await git(baseEnv(), 'rev-parse', '--verify', 'HEAD')).code).not.toBe(0);

    const allowed = await git({ ...baseEnv(), AGENTTEAMS_ALLOW: '1' }, 'commit', '-q', '-m', 'override');
    expect(allowed.code).toBe(0);
    expect(allowed.stderr).toContain('committing over claims held by ash-codex');

    const rows = await changes();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.files).toEqual(['src/a.ts']);
    expect(rows[0]!.agent).toBe('ronit-claude');
  });

  it('lets an unclaimed file through and records it', async () => {
    await claimAsAsh();
    await stageFile('docs/readme.md');
    expect((await git(baseEnv(), 'commit', '-q', '-m', 'docs')).code).toBe(0);
    expect((await changes()).map((r) => r.files)).toEqual([['docs/readme.md']]);
  });
});
