import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type RunningHub } from '@agentteams/hub';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { logCommand } from '../src/commands/log.js';
import { upCommand } from '../src/commands/up.js';
import { resolveCredential, saveCredential } from '../src/credentials.js';
import { main } from '../src/main.js';
import { makeTestCli, type TestCli } from './helpers.js';

const run = (t: TestCli, ...args: string[]) => main(['node', 'agentteams', ...args], t.deps);
const CODE_RE = /^Invite code: [a-z2-9]{4}(-[a-z2-9]{4}){3} \(expires \d{4}-\d{2}-\d{2}\)$/;
const inviteCodeOf = (t: TestCli) => /^Invite code: (\S+)/.exec(t.out[1] ?? '')![1]!;

let hub: RunningHub;
let dbDir: string;
const clis: TestCli[] = [];
const mk = (over = {}, table = {}) => { const t = makeTestCli(over, table); clis.push(t); return t; };

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'agentteams-cmd-db-'));
  hub = await startHub({ dbPath: join(dbDir, 'hub.db'), port: 0 });
});
afterAll(async () => {
  await hub.close();
  rmSync(dbDir, { recursive: true, force: true });
  clis.forEach((c) => c.cleanup());
});

describe('agentteams commands', () => {
  it('create --local prints team and invite, saves credential and installs claude', async () => {
    const t = mk({}, { claude: { code: 0 } });
    expect(await run(t, 'create', 'dev-squad', '--hub', hub.url, '--local')).toBe(0);
    expect(t.out[0]).toBe('Created team "dev-squad". You are ronit_k-claude (orchestrator).');
    expect(t.out[1]).toMatch(CODE_RE);
    expect(t.out[2]).toMatch(/^Teammates join with: agentteams join /);
    expect(await resolveCredential(t.deps, t.deps.cwd, 'claude')).not.toBeNull();
    expect(t.calls.some((c) => c.cmd === 'claude' && c.args.slice(0, 2).join(' ') === 'mcp add')).toBe(true);
    expect(existsSync(join(t.deps.cwd, 'CLAUDE.md'))).toBe(true);
  });

  it('create prints which hub it uses, and --local help says it is not the local hub', async () => {
    const t = mk({}, { claude: { code: 0 } });
    expect(await run(t, 'create', 'hub-line', '--hub', hub.url, '--local', '--no-install')).toBe(0);
    expect(t.out).toContain(`Hub: ${hub.url} (${new URL(hub.url).host})`);
    const h = mk();
    await run(h, 'create', '--help');
    expect(h.out.join('\n')).toContain('--hub local');
  });

  it('create/install warn loudly when running from an npx cache', async () => {
    const t = mk({}, { claude: { code: 0 } });
    const { runInstallers } = await import('../src/commands/install.js');
    const cred = { repoPath: t.deps.cwd, tool: 'claude' as const, hubUrl: hub.url, teamName: 'x', agentName: 'a-claude', apiKey: 'k', createdAt: 'x' };
    await runInstallers(t.deps, cred, { binPath: '/h/.npm/_npx/ab/node_modules/agentteams/dist/bin.js' });
    expect(t.err.join('\n')).toContain('npm i -g agentteams-cli && agentteams install');
    const t2 = mk({}, { claude: { code: 0 } });
    await runInstallers(t2.deps, { ...cred, repoPath: t2.deps.cwd }, { binPath: '/usr/lib/node_modules/agentteams/dist/bin.js' });
    expect(t2.err.join('\n')).not.toContain('npm i -g');
  });

  it('create detects the GitHub origin and status shows the repo', async () => {
    const t = mk({}, { 'git remote get-url origin': { stdout: 'git@github.com:ronit/my-app.git' } });
    expect(await run(t, 'create', 's-gh', '--hub', hub.url, '--no-install')).toBe(0);
    expect(await run(t, 'status')).toBe(0);
    expect(t.out.some((l) => l.includes('repo ronit/my-app'))).toBe(true);
  });

  describe('two member team', () => {
    const t1 = mk({}, { claude: { code: 0 } });
    const t2 = mk({}, { claude: { code: 0 } });
    let code = '';

    it('join as codex installs codex config and status marks orchestrator and self', async () => {
      expect(await run(t1, 'create', 'dev-squad2', '--hub', hub.url, '--local')).toBe(0);
      code = inviteCodeOf(t1);
      expect(await run(t2, 'join', code, '--agent', 'codex', '--as', 'ash', '--hub', hub.url)).toBe(0);
      expect(t2.out.some((l) => l.startsWith('Joined team "dev-squad2" as ash-codex. Repo: '))).toBe(true);
      expect(readFileSync(join(t2.deps.homedir, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.agentteams]');
      expect(await run(t2, 'status')).toBe(0);
      expect(t2.out.some((l) => l.includes('ronit_k-claude') && l.includes('★ orchestrator'))).toBe(true);
      expect(t2.out.some((l) => l.includes('ash-codex') && l.includes('you'))).toBe(true);
    });

    it('log prints history and follow streams new events until aborted', async () => {
      expect(await run(t1, 'log')).toBe(0);
      expect(t1.out.some((l) => l.includes('created team'))).toBe(true);
      expect(t1.out.some((l) => l.includes('joined ('))).toBe(true);
      const t3 = mk({}, { claude: { code: 0 } });
      const ac = new AbortController();
      const done = logCommand(t1.deps, { follow: true, limit: 20, intervalMs: 50, signal: ac.signal });
      await new Promise((r) => setTimeout(r, 100));
      expect(await run(t3, 'join', code, '--as', 'zed', '--hub', hub.url)).toBe(0);
      await new Promise((r) => setTimeout(r, 300));
      expect(t1.out.some((l) => l.includes('joined (') && l.includes('zed-claude'))).toBe(true);
      ac.abort();
      await expect(done).resolves.toBeUndefined();
    });

    it('invite rotate works for the creator and is refused for a joiner', async () => {
      expect(await run(t1, 'invite', 'rotate')).toBe(0);
      expect(t1.out.some((l) => l.startsWith('New invite code: '))).toBe(true);
      expect(await run(t2, 'invite', 'rotate', '--agent', 'codex')).toBe(1);
      expect(t2.err.some((l) => l.startsWith('agentteams: only the team creator (') && l.includes(') can rotate the invite code'))).toBe(true);
      expect(await run(t1, 'invite', 'revoke')).toBe(0);
      expect(t1.out).toContain('Invite code revoked.');
    });

    it('orchestrator reassigns', async () => {
      expect(await run(t1, 'orchestrator', 'ash-codex')).toBe(0);
      expect(t1.out).toContain('Orchestrator is now ash-codex.');
    });
  });

  it('one person can hold a claude and a codex identity; install covers both', async () => {
    const t = mk({}, { claude: { code: 0 } });
    expect(await run(t, 'create', 'dual', '--hub', hub.url, '--agent', 'claude', '--as', 'ronit', '--local')).toBe(0);
    expect(await run(t, 'join', inviteCodeOf(t), '--agent', 'codex', '--as', 'ronit', '--hub', hub.url)).toBe(0);
    const c = await resolveCredential(t.deps, t.deps.cwd, 'claude');
    const x = await resolveCredential(t.deps, t.deps.cwd, 'codex');
    expect(c!.agentName).toBe('ronit-claude');
    expect(x!.agentName).toBe('ronit-codex');
    expect(c!.apiKey).not.toBe(x!.apiKey);
    expect(await run(t, 'install')).toBe(0);
    expect(existsSync(join(t.deps.cwd, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(t.deps.cwd, 'AGENTS.md'))).toBe(true);
  });

  it('status without credentials fails cleanly', async () => {
    const t = mk();
    expect(await run(t, 'status')).toBe(1);
    expect(t.err.join('\n')).toContain('no agentteams credentials for');
  });

  it('hook stop is silent without credentials; session-start emits context', async () => {
    const t0 = mk({ readStdin: async () => '{"cwd":"/nowhere"}' });
    expect(await run(t0, 'hook', 'stop', '--tool', 'codex', '--agentteams-managed')).toBe(0);
    expect(t0.raw).toEqual([]);
    const t = mk({}, { claude: { code: 0 } });
    expect(await run(t, 'create', 'hooked', '--hub', hub.url, '--local', '--no-install')).toBe(0);
    const th = { ...t.deps, readStdin: async () => JSON.stringify({ cwd: t.deps.cwd }) };
    expect(await main(['node', 'agentteams', 'hook', 'session-start', '--tool', 'claude'], th)).toBe(0);
    expect(JSON.parse(t.raw[0]!).hookSpecificOutput.hookEventName).toBe('SessionStart');
  });

  it('create and join refuse to run in the home directory', async () => {
    const t = mk({}, { claude: { code: 0 } });
    t.deps.cwd = t.deps.homedir;
    expect(await run(t, 'create', 'x', '--hub', hub.url, '--local')).toBe(1);
    expect(t.err.join('\n')).toContain('refusing to set up a team');
    expect(await run(t, 'join', 'aaaa-bbbb-cccc-dddd', '--hub', hub.url)).toBe(1);
    expect(await resolveCredential(t.deps, t.deps.cwd, 'claude')).toBeNull();
  });

  it('unreachable hub returns 1 with a helpful message', async () => {
    const t = mk();
    expect(await run(t, 'create', 'x', '--hub', 'http://127.0.0.1:1', '--local')).toBe(1);
    expect(t.err.join('\n')).toContain('cannot reach the agentteams hub at http://127.0.0.1:1');
  });

  it('create prints the invite code before saving, so a save failure keeps it', async () => {
    const t = mk({}, {});
    const blocker = join(t.root, 'blocker');
    writeFileSync(blocker, 'x');
    t.deps.env = { AGENTTEAMS_HOME: join(blocker, 'sub') };
    expect(await run(t, 'create', 'savefail', '--hub', hub.url, '--local', '--no-install')).toBe(1);
    expect(t.out.some((l) => l.startsWith('Invite code: '))).toBe(true);
  });

  it('create and join never overwrite a credential for the same repo and tool (hub)', async () => {
    const t = mk({}, {});
    expect(await run(t, 'create', 'keep', '--hub', hub.url, '--local', '--no-install')).toBe(0);
    const code = inviteCodeOf(t);
    t.err.length = 0;
    expect(await run(t, 'join', code, '--hub', hub.url, '--as', 'b', '--no-install')).toBe(1);
    expect(t.err.join('\n')).toMatch(/already has a claude agent: ronit_k-claude on team "keep".*--agent codex/);
    expect(await run(t, 'create', 'again', '--hub', hub.url, '--local', '--no-install')).toBe(1);
    expect(t.err.join('\n')).toMatch(/already has a claude agent/);
  });

  it('refuses to guess between several agents in one repo', async () => {
    const t = mk({}, { claude: { code: 0 } });
    expect(await run(t, 'create', 'amb', '--hub', hub.url, '--local', '--no-install')).toBe(0);
    expect(await run(t, 'join', inviteCodeOf(t), '--agent', 'codex', '--as', 'b', '--hub', hub.url, '--no-install')).toBe(0);
    for (const args of [['invite', 'rotate'], ['orchestrator', 'b-codex']]) {
      t.err.length = 0;
      expect(await run(t, ...args)).toBe(1);
      expect(t.err.join('\n')).toContain('multiple agentteams agents in this repo (claude, codex); pass --agent <tool>');
    }
    expect(await run(t, 'status', '--agent', 'codex')).toBe(0);
  });

  it('status and log need no --agent when several agents share the repo; all of them are marked "you"', async () => {
    const t = mk({}, { claude: { code: 0 } });
    expect(await run(t, 'create', 'amb', '--hub', hub.url, '--local', '--no-install')).toBe(0);
    expect(await run(t, 'join', inviteCodeOf(t), '--agent', 'codex', '--as', 'b', '--hub', hub.url, '--no-install')).toBe(0);
    t.out.length = 0;
    expect(await run(t, 'status')).toBe(0);
    const rows = t.out.filter((l) => /\b(claude|codex)\b.*\byou\b/.test(l));
    expect(rows).toHaveLength(2);
    t.out.length = 0;
    expect(await run(t, 'log')).toBe(0);
    expect(t.out.join('\n')).toContain('joined');
  });

  it('log rejects a non-positive --limit', async () => {
    const t = mk();
    for (const v of ['0', 'abc', '-3']) {
      t.err.length = 0;
      expect(await run(t, 'log', '--limit', v)).toBe(1);
    }
    expect(t.err.join('\n')).toContain('agentteams: --limit must be a positive integer');
  });

  it('credentials match across symlinked and real paths', async () => {
    const t = mk();
    const real = join(t.root, 'realrepo');
    const link = join(t.root, 'linkrepo');
    mkdirSync(real);
    symlinkSync(real, link);
    const base = { tool: 'claude' as const, hubUrl: 'h', teamName: 't', agentName: 'a', apiKey: 'k', createdAt: 'x' };
    await saveCredential(t.deps, { ...base, repoPath: link });
    expect(await resolveCredential(t.deps, real, 'claude')).not.toBeNull();
    expect(await resolveCredential(t.deps, link, 'claude')).not.toBeNull();
  });

  it('up serves until aborted and then releases the port', async () => {
    const t = mk({ env: { AGENTTEAMS_HOME: join(dbDir, 'up-home') } });
    const ac = new AbortController();
    const done = upCommand(t.deps, { port: '0', signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    const line = t.out.find((l) => l.startsWith('agentteams hub listening on http://127.0.0.1:'));
    expect(line).toBeDefined();
    const url = /on (\S+) /.exec(line!)![1]!;
    expect((await fetch(`${url}/health`)).ok).toBe(true);
    ac.abort();
    await done;
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });
});
