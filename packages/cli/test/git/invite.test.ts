import { describe, expect, it } from 'vitest';
import { newTeamKey } from '../../src/git/crypto.js';
import { decodeInvite, encodeInvite, isValidRemote } from '../../src/git/invite.js';

const remotes = [
  'https://github.com/acme/repo.git',
  'ssh://git@example.com:2222/acme/repo.git',
  'git@github.com:acme/repo.git',
  'file:///tmp/remote.git',
  '/tmp/remote.git',
];

function b32(data: Buffer): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

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
  it('rejects bad schemes on encode', () => {
    const key = newTeamKey();
    for (const remote of ['http://example.com/r.git', 'ftp://x/y', 'relative/path', 'git@host', '--upload-pack=x', '']) {
      expect(() => encodeInvite({ remote, teamId: 'abc', key })).toThrow(/remote/);
    }
    expect(() => encodeInvite({ remote: '/x', teamId: 'bad id', key })).toThrow(/team id/);
    expect(() => encodeInvite({ remote: '/x', teamId: 'abc', key: 'short' })).toThrow(/key/);
  });

  it('rejects option-like, control and bidi remotes', () => {
    for (const remote of [
      'ssh://-oProxyCommand=touch${IFS}x/r',
      'git@-oFoo:x',
      'ssh://git@-oFoo/r',
      'https://-host/r',
      'https://host/-x/r',
      'git@host:-x',
      '/tmp/-x',
      'file:///tmp/-x',
      'ext::sh -c id',
      'https://host/r‮ted',
      'https://host/⁦r',
      'https://host/r\n',
      'https://ho st/r',
    ]) {
      expect(isValidRemote(remote), remote).toBe(false);
    }
    for (const remote of ['https://github.com/a/my-repo.git', 'git@github.com:a/b.git', 'ssh://git@h.io:22/a/b']) {
      expect(isValidRemote(remote), remote).toBe(true);
    }
  });

  it('rejects crafted payloads on decode (bad scheme, option host, invalid UTF-8)', () => {
    const key = Buffer.from(newTeamKey(), 'base64url');
    const craft = (remote: Buffer) => 'at1-' + b32(Buffer.concat([key, Buffer.from([3]), Buffer.from('abc'), remote]));
    expect(decodeInvite(craft(Buffer.from('https://example.com/r'))).remote).toBe('https://example.com/r');
    expect(() => decodeInvite(craft(Buffer.from('http://example.com/r')))).toThrow(/unsupported remote/);
    expect(() => decodeInvite(craft(Buffer.from('ext::sh -c id')))).toThrow(/unsupported remote/);
    expect(() => decodeInvite(craft(Buffer.from('ssh://-oProxyCommand=x/r')))).toThrow(/unsupported remote/);
    expect(() => decodeInvite(craft(Buffer.from([0x2f, 0x74, 0xff, 0xfe])))).toThrow(/encoding/);
  });

  it('keeps and rejects a BOM at the start of the remote', () => {
    const key = Buffer.from(newTeamKey(), 'base64url');
    const remote = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('/tmp/x')]);
    const code = 'at1-' + b32(Buffer.concat([key, Buffer.from([3]), Buffer.from('abc'), remote]));
    expect(() => decodeInvite(code)).toThrow(/unsupported remote/);
  });

  it('rejects non-canonical base32', () => {
    expect(() => decodeInvite(good + 'a')).toThrow();
    expect(() => decodeInvite(good + 'aa')).toThrow();
    // set a low (padding) bit in the final character
    const body = good.slice(4);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    const idx = alphabet.indexOf(body.slice(-1));
    const bumped = 'at1-' + body.slice(0, -1) + alphabet[idx | 1];
    if (idx % 2 === 0) expect(() => decodeInvite(bumped)).toThrow();
  });
});
