import { describe, expect, it } from 'vitest';
import { encrypt, newAgentKeyPair, newTeamKey, sign } from '../../src/git/crypto.js';
import { decodeSegment, encodeSegment, type Op } from '../../src/git/segment.js';

const teamKey = newTeamKey();
const kai = newAgentKeyPair();
const mia = newAgentKeyPair();
const keys: Record<string, string> = { kai: kai.publicKey, mia: mia.publicKey };
const lookup = (id: string) => keys[id];
const op = (agent: string, n: number): Op => ({
  v: 1,
  id: `id${n}`,
  ts: `2026-10-16T21:00:00.000Z-000${n}`,
  agent,
  op: 'sendMessage',
  input: { text: 'hi', n },
});

/** Build a validly encrypted + signed blob around arbitrary plaintext. */
function forge(plaintext: string, signer = kai.privateKey): Buffer {
  const pt = Buffer.from(plaintext);
  return encrypt(teamKey, Buffer.concat([sign(signer, pt), pt]));
}

describe('segment codec', () => {
  it('round-trips', () => {
    const seg = { agent: 'kai', seq: 3, ops: [op('kai', 1), op('kai', 2)] };
    const res = decodeSegment(encodeSegment(seg, teamKey, kai.privateKey), teamKey, lookup);
    expect(res).toEqual({ ok: true, segment: { v: 1, ...seg } });
  });
  it('round-trips an empty batch', () => {
    const res = decodeSegment(encodeSegment({ agent: 'kai', seq: 0, ops: [] }, teamKey, kai.privateKey), teamKey, lookup);
    expect(res.ok).toBe(true);
  });
  it('a flipped byte anywhere fails to decrypt', () => {
    const buf = encodeSegment({ agent: 'kai', seq: 1, ops: [op('kai', 1)] }, teamKey, kai.privateKey);
    for (let i = 0; i < buf.length; i++) {
      const b = Buffer.from(buf);
      b[i] = b[i]! ^ 0x80;
      expect(decodeSegment(b, teamKey, lookup)).toEqual({ ok: false, reason: 'decrypt' });
    }
  });
  it('wrong team key and truncated/empty input fail to decrypt', () => {
    const buf = encodeSegment({ agent: 'kai', seq: 1, ops: [] }, teamKey, kai.privateKey);
    expect(decodeSegment(buf, newTeamKey(), lookup)).toEqual({ ok: false, reason: 'decrypt' });
    expect(decodeSegment(buf.subarray(0, 20), teamKey, lookup)).toEqual({ ok: false, reason: 'decrypt' });
    expect(decodeSegment(Buffer.alloc(0), teamKey, lookup)).toEqual({ ok: false, reason: 'decrypt' });
  });
  it('rejects a segment signed by another agent key', () => {
    const buf = encodeSegment({ agent: 'kai', seq: 1, ops: [op('kai', 1)] }, teamKey, mia.privateKey);
    expect(decodeSegment(buf, teamKey, lookup)).toEqual({ ok: false, reason: 'bad-signature' });
  });
  it('rejects an unknown agent', () => {
    const buf = encodeSegment({ agent: 'zed', seq: 1, ops: [] }, teamKey, kai.privateKey);
    expect(decodeSegment(buf, teamKey, lookup)).toEqual({ ok: false, reason: 'unknown-agent' });
  });
  it('rejects malformed content inside valid encryption', () => {
    const bad = { ok: false, reason: 'malformed' };
    expect(decodeSegment(forge('not json'), teamKey, lookup)).toEqual(bad);
    expect(decodeSegment(forge('[1]'), teamKey, lookup)).toEqual(bad);
    expect(decodeSegment(forge('{"v":1,"agent":"kai"}'), teamKey, lookup)).toEqual(bad);
    expect(decodeSegment(forge('{"v":1,"agent":"kai","seq":1,"ops":[{"x":1}]}'), teamKey, lookup)).toEqual(bad);
    expect(decodeSegment(encrypt(teamKey, Buffer.alloc(10)), teamKey, lookup)).toEqual(bad);
  });
  it('rejects an op whose agent differs from the signer', () => {
    const body = JSON.stringify({ v: 1, agent: 'kai', seq: 1, ops: [op('mia', 1)] });
    expect(decodeSegment(forge(body), teamKey, lookup)).toEqual({ ok: false, reason: 'malformed' });
  });
  it('rejects unsupported versions', () => {
    expect(decodeSegment(forge('{"v":2,"agent":"kai","seq":1,"ops":[]}'), teamKey, lookup)).toEqual({ ok: false, reason: 'version' });
  });
  it('treats a garbage registered key as a bad signature without throwing', () => {
    const buf = encodeSegment({ agent: 'kai', seq: 1, ops: [] }, teamKey, kai.privateKey);
    expect(decodeSegment(buf, teamKey, () => 'garbage')).toEqual({ ok: false, reason: 'bad-signature' });
  });
});
