import { describe, expect, it } from 'vitest';
import { resolveMemberName } from '../src/repo.js';
import { fakeExec } from './helpers.js';

describe('resolveMemberName', () => {
  const cwd = '/w/app';
  const gitName = (name: string, code = 0) => fakeExec({ 'git config user.name': { stdout: `${name}\n`, code } });
  it('prefers the configured user.name over the OS username', async () => {
    expect(await resolveMemberName({ exec: gitName('Ana Lopez'), username: 'osuser' }, cwd)).toBe('ana_lopez');
  });
  it('uses the OS username when there is no user.name', async () => {
    expect(await resolveMemberName({ exec: fakeExec({}), username: 'Ronit K' }, cwd)).toBe('ronit_k');
    expect(await resolveMemberName({ exec: gitName('', 1), username: 'osuser' }, cwd)).toBe('osuser');
  });
  it('skips a user.name that is a tool name, falling to the OS username', async () => {
    expect(await resolveMemberName({ exec: gitName('codex'), username: 'ana' }, cwd)).toBe('ana');
  });
  it('skips generic OS usernames and tool names, finally "me"', async () => {
    expect(await resolveMemberName({ exec: fakeExec({}), username: 'codex' }, cwd)).toBe('me');
    expect(await resolveMemberName({ exec: gitName('Claude'), username: 'root' }, cwd)).toBe('me');
    expect(await resolveMemberName({ exec: gitName('root'), username: 'codex' }, cwd)).toBe('me');
  });
});
