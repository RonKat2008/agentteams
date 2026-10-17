import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCredentials, saveCredential, type Credential } from '../src/credentials.js';
import { realExec, type CliDeps, type Exec } from '../src/deps.js';
import { main } from '../src/main.js';
import { makeTestCli, type TestCli } from './helpers.js';
import { makeRepo, type TempRepo } from './localHelpers.js';

const noNetwork = (() => { throw new Error('no network on the local transport'); }) as unknown as typeof fetch;
const exec: Exec = async (cmd, args, opts) => (cmd === 'git' ? realExec(cmd, args, opts) : { code: 0, stdout: '', stderr: '' });
const CODE_RE = /^Invite code: (\S+) \(expires \d{4}-\d{2}-\d{2}\)$/;

interface Cli extends TestCli { run: (...args: string[]) => Promise<number> }

function cli(repo: string): Cli {
  const t = makeTestCli({ exec, fetch: noNetwork });
  const deps: CliDeps = { ...t.deps, cwd: repo };
  const out: string[] = [];
  const err: string[] = [];
  deps.out = (l) => out.push(l);
  deps.err = (l) => err.push(l);
  return { ...t, deps, out, err, run: (...args) => main(['node', 'agentteams', ...args], deps) };
}

const credOf = async (c: Cli): Promise<Credential> => (await loadCredentials(c.deps))[0]!;
const codeIn = (lines: string[]): string => /([a-z2-9]{4}(?:-[a-z2-9]{4}){3})/.exec(lines.join('\n'))![1]!;

describe('invite codes can be shown again (local team)', () => {
  let r: TempRepo;
  let c: Cli;
  beforeEach(async () => {
    r = makeRepo();
    c = cli(r.repo);
    expect(await c.run('create', 'acme', '--as', 'alice', '--no-install')).toBe(0);
  });
  afterEach(() => { c.cleanup(); r.cleanup(); });

  it('create stores the plaintext code in the credential and says to copy it now', async () => {
    const code = CODE_RE.exec(c.out.find((l) => l.startsWith('Invite code:'))!)![1]!;
    expect((await credOf(c)).invite?.code).toBe(code);
    expect(c.out.join('\n')).toMatch(/copy.*now.*password/i);
  });

  it.each([[[]], [['show']]])('invite %j reprints the stored code and join command', async (args) => {
    const code = (await credOf(c)).invite!.code;
    c.out.length = 0;
    expect(await c.run('invite', ...args)).toBe(0);
    const text = c.out.join('\n');
    expect(text).toContain(`Invite code: ${code}`);
    expect(text).toContain(`agentteams join ${code}`);
    expect(text).toMatch(/password/i);
  });

  it('rotate (subcommand or --rotate) replaces the stored code', async () => {
    const first = (await credOf(c)).invite!.code;
    c.out.length = 0;
    expect(await c.run('invite', '--rotate')).toBe(0);
    const second = codeIn(c.out);
    expect(second).not.toBe(first);
    expect((await credOf(c)).invite?.code).toBe(second);
    c.out.length = 0;
    expect(await c.run('invite', 'rotate')).toBe(0);
    expect((await credOf(c)).invite?.code).toBe(codeIn(c.out));
  });

  it('revoke drops the stored code; show then points at --rotate', async () => {
    expect(await c.run('invite', 'revoke')).toBe(0);
    expect((await credOf(c)).invite).toBeUndefined();
    expect(await c.run('invite')).toBe(1);
    expect(c.err.join('\n')).toContain('agentteams invite --rotate');
  });

  it('a credential saved before codes were stored explains --rotate', async () => {
    const { invite: _gone, ...old } = await credOf(c);
    await saveCredential(c.deps, old);
    expect(await c.run('invite')).toBe(1);
    expect(c.err.join('\n')).toMatch(/not stored.*agentteams invite --rotate/s);
  });

  it('an expired stored code is not printed', async () => {
    const cred = await credOf(c);
    await saveCredential(c.deps, { ...cred, invite: { code: cred.invite!.code, expiresAt: '2020-01-01T00:00:00.000Z' } });
    c.out.length = 0;
    expect(await c.run('invite')).toBe(1);
    expect(c.out.join('\n')).not.toContain(cred.invite!.code);
    expect(c.err.join('\n')).toMatch(/expired.*agentteams invite --rotate/s);
  });

  it('the credential file stays private (0600)', async () => {
    const { statSync } = await import('node:fs');
    const { credentialsPath } = await import('../src/paths.js');
    expect(statSync(credentialsPath(c.deps)).mode & 0o777).toBe(0o600);
  });
});
