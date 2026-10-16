import { describe, expect, it } from 'vitest';
import { newTeamKey } from '../../src/git/crypto.js';
import { decodeInvite, encodeInvite } from '../../src/git/invite.js';

const remotes = [
  'https://github.com/acme/repo.git',
  'ssh://git@example.com:2222/acme/repo.git',
  'git@github.com:acme/repo.git',
  'file:///tmp/remote.git',
  '/tmp/remote.git',
];

describe('invite', () => {
  it.each(remotes)('round-trips %s', (remote) => {
    const key = newTeamKey();
    const code = encodeInvite({ remote, teamId: 'team_01-abc', key });
    expect(code).toMatch(/^at1-[a-z2-7]+$/);
    expect(decodeInvite(code)).toEqual({ remote, teamId: 'team_01-abc', key });
    expect(decodeInvite(`  ${code}\n`).remote).toBe(remote);
  });

  it('is reasonably compact', () => {
    const code = encodeInvite({ remote: 'git@github.com:acme/repo.git', teamId: 'abc123', key: newTeamKey() });
    expect(code.length).toBeLessThanOrEqual(112);
  });

  const good = encodeInvite({ remote: 'https://github.com/a/b.git', teamId: 'abc', key: newTeamKey() });
  it('rejects wrong prefix', () => {
    expect(() => decodeInvite(good.replace('at1-', 'at2-'))).toThrow(/start with "at1-"/);
    expect(() => decodeInvite('hello')).toThrow(/invite code/);
  });
  it('rejects empty body, truncation and bad chars', () => {
    expect(() => decodeInvite('at1-')).toThrow(/empty/);
    expect(() => decodeInvite(good.slice(0, 20))).toThrow(/truncated/);
    expect(() => decodeInvite(good.slice(0, 60))).toThrow();
    expect(() => decodeInvite(good + '!')).toThrow(/invalid characters/);
    expect(() => decodeInvite('at1-' + good.slice(4).toUpperCase())).toThrow(/invalid characters/);
    expect(() => decodeInvite('at1-' + 'a'.repeat(5000))).toThrow(/too long/);
  });
  it('rejects bad schemes on encode and decode', () => {
    const key = newTeamKey();
    for (const remote of ['http://example.com/r.git', 'ftp://x/y', 'relative/path', 'git@host', '--upload-pack=x', '']) {
      expect(() => encodeInvite({ remote, teamId: 'abc', key })).toThrow(/remote/);
    }
    expect(() => encodeInvite({ remote: '/x', teamId: 'bad id', key })).toThrow(/team id/);
    expect(() => encodeInvite({ remote: '/x', teamId: 'abc', key: 'short' })).toThrow(/key/);
  });
});
