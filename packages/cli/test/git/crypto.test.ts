import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, newAgentKeyPair, newTeamKey, sign, verify } from '../../src/git/crypto.js';

describe('crypto', () => {
  it('team key is 32 bytes base64url and unique', () => {
    const k = newTeamKey();
    expect(Buffer.from(k, 'base64url')).toHaveLength(32);
    expect(newTeamKey()).not.toBe(k);
  });
  it('round-trips and uses a fresh nonce', () => {
    const k = newTeamKey();
    const a = encrypt(k, Buffer.from('hello'));
    expect(decrypt(k, a)?.toString()).toBe('hello');
    expect(a.equals(encrypt(k, Buffer.from('hello')))).toBe(false);
    expect(a).toHaveLength(12 + 16 + 5);
  });
  it('rejects every single flipped byte', () => {
    const k = newTeamKey();
    const a = encrypt(k, Buffer.from('some payload'));
    for (let i = 0; i < a.length; i++) {
      const b = Buffer.from(a);
      b[i] = b[i]! ^ 1;
      expect(decrypt(k, b)).toBeNull();
    }
  });
  it('rejects wrong key and short input', () => {
    const a = encrypt(newTeamKey(), Buffer.from('x'));
    expect(decrypt(newTeamKey(), a)).toBeNull();
    expect(decrypt(newTeamKey(), Buffer.alloc(5))).toBeNull();
  });
  it('signs and verifies, rejecting other keys, data and malformed input', () => {
    const kp = newAgentKeyPair();
    expect(Buffer.from(kp.publicKey, 'base64url')).toHaveLength(32);
    const sig = sign(kp.privateKey, Buffer.from('data'));
    expect(sig).toHaveLength(64);
    expect(verify(kp.publicKey, Buffer.from('data'), sig)).toBe(true);
    expect(verify(kp.publicKey, Buffer.from('datb'), sig)).toBe(false);
    expect(verify(newAgentKeyPair().publicKey, Buffer.from('data'), sig)).toBe(false);
    expect(verify('not-a-key', Buffer.from('data'), sig)).toBe(false);
    expect(verify(kp.publicKey, Buffer.from('data'), sig.subarray(1))).toBe(false);
  });
});
