import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHub } from '@agentteams/hub';
import { saveCredential } from '../src/credentials.js';
import { realExec, type CliDeps } from '../src/deps.js';
import { oneLine } from '../src/format.js';
import { runPostCommit, runPreCommit } from '../src/gitHooks.js';
import { HubClient } from '../src/hubClient.js';

const ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const saved: Record<string, string | undefined> = {};
let tmp: string;
let repo: string;
let hub: Awaited<ReturnType<typeof startHub>>;
let ronitKey: string;
let ashKey: string;
let inviteCode: string;
let err: string[];

const git = async (cwd: string, ...args: string[]) => {
  const r = await realExec('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const mkDeps = (env: NodeJS.ProcessEnv = {}): CliDeps => ({
  env: { AGENTTEAMS_HOME: join(tmp, 'ahome'), ...env }, cwd: repo, exec: realExec, fetch: globalThis.fetch,
  out: () => {}, write: () => {}, err: (l) => err.push(l), readStdin: async () => '',
  homedir: join(tmp, 'home'), username: 'T',
});
const mcp = async (key: string, name: string, args: Record<string, unknown>) => {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${hub.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  await client.callTool({ name, arguments: args });
  await client.close();
};
const stage = async (...files: string[]) => {
  for (const f of files) { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), `${f}\n`); }
  await git(repo, 'add', ...files);
};
const cred = (key: string, hubUrl = hub.url) => ({
  repoPath: repo, tool: 'claude' as const, hubUrl, teamName: 'dev-squad', agentName: 'ronit-claude', apiKey: key, createdAt: '2026-01-01T00:00:00.000Z',
});

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  err = [];
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'at-ghr-')));
  repo = join(tmp, 'repo');
  mkdirSync(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  hub = await startHub({ dbPath: join(tmp, 'hub.db'), port: 0 });
  const anon = new HubClient(hub.url);
  const created = await anon.createTeam({ name: 'dev-squad', member: 'ronit', tool: 'claude', repo: { provider: 'local' } });
  const ash = await anon.joinTeam({ inviteCode: created.inviteCode, member: 'ash', tool: 'codex' });
  ronitKey = created.apiKey;
  inviteCode = created.inviteCode;
  ashKey = ash.apiKey;
});
afterEach(async () => {
  await hub.close();
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(tmp, { recursive: true, force: true });
  await rm(tmp, { recursive: true, force: true });
});

describe('runPreCommit', () => {
  it('returns 0 silently with no credential', async () => {
    await stage('src/a.ts');
    expect(await runPreCommit(mkDeps())).toBe(0);
    expect(err).toEqual([]);
  });

  it('returns 0 with a warning when the hub is down', async () => {
    await saveCredential(mkDeps(), cred(ronitKey, 'http://127.0.0.1:1'));
    await stage('src/a.ts');
    expect(await runPreCommit(mkDeps())).toBe(0);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('agentteams: warning: could not check file claims');
    expect(err.join('\n')).toContain('committing anyway');
  });

  it('returns 0 when nothing is staged', async () => {
    await saveCredential(mkDeps(), cred(ronitKey));
    expect(await runPreCommit(mkDeps())).toBe(0);
    expect(err).toEqual([]);
  });

  it('blocks on another agent\'s exclusive claim and names the agent', async () => {
    await saveCredential(mkDeps(), cred(ronitKey));
    await mcp(ashKey, 'claim_files', { globs: ['src/**'], exclusive: true });
    await stage('src/a.ts');
    expect(await runPreCommit(mkDeps())).toBe(3);
    const text = err.join('\n');
    expect(text).toContain('commit blocked');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('ash-codex');
    expect(text).toContain('AGENTTEAMS_ALLOW=1 git commit');
  });

  it('allows with AGENTTEAMS_ALLOW=1 and records one claim_overridden event', async () => {
    await saveCredential(mkDeps(), cred(ronitKey));
    await mcp(ashKey, 'claim_files', { globs: ['src/**'], exclusive: true });
    await stage('src/a.ts');
    expect(await runPreCommit(mkDeps({ AGENTTEAMS_ALLOW: '1' }))).toBe(0);
    expect(err.join('\n')).toContain('committing over claims held by ash-codex');
    const events = await new HubClient(hub.url, { apiKey: ronitKey }).activity({ limit: 50 });
    expect(events.filter((e) => e.type === 'claim_overridden')).toHaveLength(1);
  });

  it.each(['true', '0', ''])('does not override when AGENTTEAMS_ALLOW=%j', async (v) => {
    await saveCredential(mkDeps(), cred(ronitKey));
    await mcp(ashKey, 'claim_files', { globs: ['src/**'], exclusive: true });
    await stage('src/a.ts');
    expect(await runPreCommit(mkDeps({ AGENTTEAMS_ALLOW: v }))).toBe(3);
    const events = await new HubClient(hub.url, { apiKey: ronitKey }).activity({ limit: 50 });
    expect(events.filter((e) => e.type === 'claim_overridden')).toHaveLength(0);
  });

  it('blocks a rename away from a claimed path', async () => {
    await saveCredential(mkDeps(), cred(ronitKey));
    await stage('src/old.ts');
    await git(repo, 'commit', '-q', '-m', 'add old');
    await mcp(ashKey, 'claim_files', { globs: ['src/**'], exclusive: true });
    mkdirSync(join(repo, 'lib'));
    await git(repo, 'mv', 'src/old.ts', 'lib/new.ts');
    expect(await runPreCommit(mkDeps())).toBe(3);
    expect(err.join('\n')).toContain('src/old.ts');
  });

  it('allows a non-exclusive claim', async () => {
    await saveCredential(mkDeps(), cred(ronitKey));
    await mcp(ashKey, 'claim_files', { globs: ['src/**'], exclusive: false });
    await stage('src/a.ts');
    expect(await runPreCommit(mkDeps())).toBe(0);
    expect(err).toEqual([]);
  });

  it('accepts whichever tool credential matches the repo', async () => {
    await saveCredential(mkDeps(), { ...cred(ashKey), tool: 'codex', agentName: 'ash-codex' });
    await mcp(ronitKey, 'claim_files', { globs: ['src/**'], exclusive: true });
    await stage('src/a.ts');
    expect(await runPreCommit(mkDeps())).toBe(3);
  });
});

describe('agent selection when claude and codex share a repo', () => {
  let codexKey: string;
  let wt: string;
  const depsIn = (cwd: string, env: NodeJS.ProcessEnv = {}): CliDeps => ({ ...mkDeps(env), cwd });

  beforeEach(async () => {
    const codex = await new HubClient(hub.url).joinTeam({ inviteCode, member: 'ronit', tool: 'codex' });
    codexKey = codex.apiKey;
    await saveCredential(mkDeps(), cred(ronitKey));
    await saveCredential(mkDeps(), { ...cred(codexKey), tool: 'codex', agentName: 'ronit-codex' });
    writeFileSync(join(repo, 'README.md'), 'x\n');
    await git(repo, 'add', 'README.md');
    await git(repo, 'commit', '-q', '-m', 'init');
    wt = join(tmp, 'repo.at', 'ronit-codex-1');
    await git(repo, 'worktree', 'add', '-b', 'at/ronit-codex/1', wt);
  });

  const stageIn = async (cwd: string, f: string) => {
    mkdirSync(join(cwd, f, '..'), { recursive: true });
    writeFileSync(join(cwd, f), `${f}\n`);
    await git(cwd, 'add', f);
  };

  it('does not block the codex worktree on a claim held by codex itself', async () => {
    await mcp(codexKey, 'claim_files', { globs: ['src/**'], exclusive: true });
    await stageIn(wt, 'src/a.ts');
    expect(await runPreCommit(depsIn(wt))).toBe(0);
    expect(err).toEqual([]);
  });

  it('credits the post-commit to ronit-codex on the codex branch', async () => {
    await stageIn(wt, 'src/a.ts');
    await git(wt, 'commit', '-q', '-m', 'codex work');
    expect(await runPostCommit(depsIn(wt))).toBe(0);
    const res = await fetch(`${hub.url}/api/team/changes`, { headers: { authorization: `Bearer ${ashKey}` } });
    const rows = (await res.json()) as { agent: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent).toBe('ronit-codex');
  });

  it('still blocks the codex worktree on a claim held by the claude agent', async () => {
    await mcp(ronitKey, 'claim_files', { globs: ['src/**'], exclusive: true });
    await stageIn(wt, 'src/a.ts');
    expect(await runPreCommit(depsIn(wt))).toBe(3);
    expect(err.join('\n')).toContain('ronit-claude');
  });
});

describe('odd and numerous staged paths', () => {
  it('still blocks a claimed file staged next to a 400-char path', async () => {
    await saveCredential(mkDeps(), cred(ronitKey));
    await mcp(ashKey, 'claim_files', { globs: ['src/**'], exclusive: true });
    const long = `${['a', 'b', 'c', 'd'].map((c) => c.repeat(95)).join('/')}/f.md`; // ~390 chars, each segment under the 255 limit
    await stage('src/a.ts', long);
    expect(await runPreCommit(mkDeps())).toBe(3);
    expect(err.join('\n')).toContain('src/a.ts');
    expect(err.join('\n')).not.toContain('could not check');
  });

  it('skips a path the hub would reject (over 1024 chars) instead of dropping the whole check', async () => {
    await saveCredential(mkDeps(), cred(ronitKey));
    await mcp(ashKey, 'claim_files', { globs: ['src/**'], exclusive: true });
    await stage('src/a.ts');
    // Not creatable on disk; feed the oversized path through a fake exec instead.
    const huge = `d/${'y'.repeat(1100)}`;
    const exec: CliDeps['exec'] = async (cmd, args, o) => {
      const r = await realExec(cmd, args, o);
      return cmd === 'git' && args.includes('--cached') ? { ...r, stdout: `${r.stdout}${huge}\0` } : r;
    };
    expect(await runPreCommit({ ...mkDeps(), exec })).toBe(3);
    expect(err.join('\n')).not.toContain('could not check');
  });

  it('checks a 1500-file commit in batches and blocks on the one claimed file', async () => {
    await saveCredential(mkDeps(), cred(ronitKey));
    await mcp(ashKey, 'claim_files', { globs: ['claimed/**'], exclusive: true });
    const files = Array.from({ length: 1499 }, (_, i) => `bulk/f${i}.txt`);
    mkdirSync(join(repo, 'bulk'));
    for (const f of files) writeFileSync(join(repo, f), 'x\n');
    await stage('claimed/one.ts');
    await git(repo, 'add', 'bulk');
    expect(await runPreCommit(mkDeps())).toBe(3);
    expect(err.join('\n')).toContain('claimed/one.ts');
    expect(err.join('\n')).not.toContain('could not check');
  });
});

describe('sanitiser path', () => {
  it('collapses line breaks in peer-supplied fields', () => {
    expect(oneLine('evil\n  forged: line\r\nx')).not.toMatch(/[\n\r]/);
  });
});

describe('runPostCommit', () => {
  const commit = async () => {
    await stage('src/a.ts', 'README.md');
    await git(repo, 'commit', '-q', '-m', 'add things');
    return git(repo, 'rev-parse', 'HEAD');
  };
  const changes = async () => {
    const res = await fetch(`${hub.url}/api/team/changes`, { headers: { authorization: `Bearer ${ashKey}` } });
    return (await res.json()) as { sha: string; files: string[]; insertions: number; deletions: number }[];
  };

  it('records the commit once, even when run twice', async () => {
    await saveCredential(mkDeps(), cred(ronitKey));
    const sha = await commit();
    expect(await runPostCommit(mkDeps())).toBe(0);
    expect(await runPostCommit(mkDeps())).toBe(0);
    const rows = await changes();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sha).toBe(sha);
    expect(rows[0]!.files.sort()).toEqual(['README.md', 'src/a.ts']);
    expect(rows[0]!.insertions).toBe(2);
    expect(err).toEqual([]);
  });

  it('returns 0 with a warning when the hub is down', async () => {
    await saveCredential(mkDeps(), cred(ronitKey, 'http://127.0.0.1:1'));
    await commit();
    expect(await runPostCommit(mkDeps())).toBe(0);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('agentteams: warning');
  });

  it('returns 0 silently with no credential', async () => {
    await commit();
    expect(await runPostCommit(mkDeps())).toBe(0);
    expect(err).toEqual([]);
  });
});
