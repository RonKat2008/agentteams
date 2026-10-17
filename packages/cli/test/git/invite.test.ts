import { describe, expect, it } from 'vitest';
import { newAgentKeyPair, newTeamKey } from '../../src/git/crypto.js';
import { decodeInvite, encodeInvite, isValidRemote, MAX_INVITE_LENGTH } from '../../src/git/invite.js';

const creator = { agentId: '01M53M31E10004AT4C85BXMTTX', publicKey: newAgentKeyPair().publicKey };
/** A raw v1 payload with a valid creator, for crafted-payload tests. */
const rawPayload = (key: Buffer, teamId: Buffer, remote: Buffer, version = 1): Buffer => Buffer.concat([
  Buffer.from([version]), key, Buffer.from(creator.publicKey, 'base64url'), Buffer.from([creator.agentId.length]),
  Buffer.from(creator.agentId), Buffer.from([teamId.length]), teamId, remote,
]);

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
    const code = encodeInvite({ remote, teamId: 'team_01-abc', key, creator });
    expect(code).toMatch(/^at1-[a-z2-7]+$/);
    expect(decodeInvite(code)).toEqual({ remote, teamId: 'team_01-abc', key, creator });
    expect(decodeInvite(`  ${code}\n`).remote).toBe(remote);
  });

  it('is reasonably compact', () => {
    const code = encodeInvite({ remote: 'git@github.com:acme/repo.git', teamId: 'abc123', key: newTeamKey(), creator });
    expect(code.length).toBeLessThanOrEqual(210);
  });

  const good = encodeInvite({ remote: 'https://github.com/a/b.git', teamId: 'abc', key: newTeamKey(), creator });
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
      expect(() => encodeInvite({ remote, teamId: 'abc', key, creator })).toThrow(/remote/);
    }
    expect(() => encodeInvite({ remote: '/x', teamId: 'bad id', key, creator })).toThrow(/team id/);
    expect(() => encodeInvite({ remote: '/x', teamId: 'abc', key: 'short', creator })).toThrow(/key/);
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
    const craft = (remote: Buffer) => 'at1-' + b32(rawPayload(key, Buffer.from('abc'), remote));
    expect(decodeInvite(craft(Buffer.from('https://example.com/r'))).remote).toBe('https://example.com/r');
    expect(() => decodeInvite(craft(Buffer.from('http://example.com/r')))).toThrow(/unsupported remote/);
    expect(() => decodeInvite(craft(Buffer.from('ext::sh -c id')))).toThrow(/unsupported remote/);
    expect(() => decodeInvite(craft(Buffer.from('ssh://-oProxyCommand=x/r')))).toThrow(/unsupported remote/);
    expect(() => decodeInvite(craft(Buffer.from([0x2f, 0x74, 0xff, 0xfe])))).toThrow(/encoding/);
  });

  it('keeps and rejects a BOM at the start of the remote', () => {
    const key = Buffer.from(newTeamKey(), 'base64url');
    const remote = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('/tmp/x')]);
    const code = 'at1-' + b32(rawPayload(key, Buffer.from('abc'), remote));
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

  it('carries the creator, and decodes strictly (version, creator id, tampering)', () => {
    const key = Buffer.from(newTeamKey(), 'base64url');
    const ok = 'at1-' + b32(rawPayload(key, Buffer.from('abc'), Buffer.from('/tmp/r')));
    expect(decodeInvite(ok).creator).toEqual(creator);
    expect(ok.length).toBeLessThanOrEqual(MAX_INVITE_LENGTH);
    expect(() => decodeInvite('at1-' + b32(rawPayload(key, Buffer.from('abc'), Buffer.from('/tmp/r'), 2)))).toThrow(/unsupported version/);
    // a creator id with a bad character, or of length 0
    const bad = rawPayload(key, Buffer.from('abc'), Buffer.from('/tmp/r'));
    bad[1 + 32 + 32 + 1] = 0x2d; // '-'
    expect(() => decodeInvite('at1-' + b32(bad))).toThrow(/creator id/);
    const zero = Buffer.concat([Buffer.from([1]), key, Buffer.from(creator.publicKey, 'base64url'), Buffer.from([0, 3]), Buffer.from('abc/tmp/r')]);
    expect(() => decodeInvite('at1-' + b32(zero))).toThrow(/truncated or corrupt/);
    // flipping a bit of the creator key changes the decoded creator (join then refuses the team: see gitTeam tests)
    const flipped = rawPayload(key, Buffer.from('abc'), Buffer.from('/tmp/r'));
    flipped[1 + 32] ^= 1;
    expect(decodeInvite('at1-' + b32(flipped)).creator.publicKey).not.toBe(creator.publicKey);
  });

  it('refuses to encode an invalid creator', () => {
    const key = newTeamKey();
    expect(() => encodeInvite({ remote: '/x', teamId: 'abc', key, creator: { ...creator, publicKey: 'short' } })).toThrow(/creator public key/);
    expect(() => encodeInvite({ remote: '/x', teamId: 'abc', key, creator: { ...creator, agentId: 'bad id' } })).toThrow(/creator agent id/);
  });
});
