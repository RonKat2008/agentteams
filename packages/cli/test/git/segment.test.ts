import { describe, expect, it } from 'vitest';
import { encrypt, newAgentKeyPair, newTeamKey, sign } from '../../src/git/crypto.js';
import { formatHlc } from '../../src/git/hlc.js';
import { MAX_OPS_PER_SEGMENT, MAX_SEGMENT_BYTES, decodeSegment, encodeSegment, type Op } from '../../src/git/segment.js';

const teamKey = newTeamKey();
const TEAM = 'team01';
const KAI = 'kai0000000A1';
const MIA = 'mia0000000B2';
const kai = newAgentKeyPair();
const mia = newAgentKeyPair();
const keys = new Map<string, string>([
  [KAI, kai.publicKey],
  [MIA, mia.publicKey],
]);
const lookup = (id: string) => keys.get(id);
const T0 = Date.UTC(2026, 9, 16, 21);
const op = (agent: string, n: number): Op => ({
  v: 1,
  id: `id${n}`,
  ts: formatHlc(T0, n),
  agent,
  op: 'sendMessage',
  input: { text: 'hi', n },
});
const at = (agent: string, seq: number, teamId = TEAM) => ({ teamId, agent, seq });
const enc = (agent: string, seq: number, ops: Op[], priv = kai.privateKey, teamId = TEAM) =>
  encodeSegment({ teamId, agent, seq, ops }, teamKey, priv);

/** Build a validly encrypted + signed blob (correct context) around arbitrary plaintext. */
function forge(plaintext: string, loc = at(KAI, 1), signer = kai.privateKey): Buffer {
  const ctx = Buffer.from(`agentteams-segment-v1\0${loc.teamId}\0${loc.agent}\0${loc.seq}\0`);
  const pt = Buffer.from(plaintext);
  return encrypt(teamKey, Buffer.concat([sign(signer, Buffer.concat([ctx, pt])), pt]), ctx);
}

describe('segment codec', () => {
  it('round-trips', () => {
    const ops = [op(KAI, 1), op(KAI, 2)];
    const res = decodeSegment(enc(KAI, 3, ops), teamKey, at(KAI, 3), lookup);
    expect(res).toEqual({ ok: true, segment: { v: 1, agent: KAI, seq: 3, ops } });
  });
  it('round-trips an empty batch', () => {
    expect(decodeSegment(enc(KAI, 0, []), teamKey, at(KAI, 0), lookup).ok).toBe(true);
  });
  it('a flipped byte anywhere fails to decrypt', () => {
    const buf = enc(KAI, 1, [op(KAI, 1)]);
    for (let i = 0; i < buf.length; i++) {
      const b = Buffer.from(buf);
      b[i] = b[i]! ^ 0x80;
      expect(decodeSegment(b, teamKey, at(KAI, 1), lookup)).toEqual({ ok: false, reason: 'decrypt' });
    }
  });
  it('wrong team key and truncated/empty input fail to decrypt', () => {
    const buf = enc(KAI, 1, []);
    expect(decodeSegment(buf, newTeamKey(), at(KAI, 1), lookup)).toEqual({ ok: false, reason: 'decrypt' });
    expect(decodeSegment(buf.subarray(0, 20), teamKey, at(KAI, 1), lookup)).toEqual({ ok: false, reason: 'decrypt' });
    expect(decodeSegment(Buffer.alloc(0), teamKey, at(KAI, 1), lookup)).toEqual({ ok: false, reason: 'decrypt' });
  });
  it('rejects a segment signed by another agent key', () => {
    const buf = enc(KAI, 1, [op(KAI, 1)], mia.privateKey);
    expect(decodeSegment(buf, teamKey, at(KAI, 1), lookup)).toEqual({ ok: false, reason: 'bad-signature' });
  });
  it('rejects an unknown agent', () => {
    const zed = 'zed0000000Z9';
    expect(decodeSegment(enc(zed, 1, []), teamKey, at(zed, 1), lookup)).toEqual({ ok: false, reason: 'unknown-agent' });
  });

  describe('context binding (replay)', () => {
    const buf = enc(KAI, 5, [op(KAI, 1)]);
    it('cross-team replay: re-encrypting for another team id is rejected', () => {
      expect(decodeSegment(buf, teamKey, at(KAI, 5, 'team02'), lookup).ok).toBe(false);
      // attacker re-encrypts the same inner bytes under the same key for a different team slot
      const ctxB = Buffer.from(`agentteams-segment-v1\0team02\0${KAI}\0${5}\0`);
      const replayed = encrypt(teamKey, Buffer.concat([Buffer.alloc(64), Buffer.from('{}')]), ctxB);
      expect(decodeSegment(replayed, teamKey, at(KAI, 5, 'team02'), lookup).ok).toBe(false);
    });
    it('cross-team: a segment signed for team A fails signature check when relabelled as team B', () => {
      // valid AAD for B, but signature was made over team A context
      const ptJson = JSON.stringify({ v: 1, agent: KAI, seq: 5, ops: [op(KAI, 1)] });
      const pt = Buffer.from(ptJson);
      const ctxA = Buffer.from(`agentteams-segment-v1\0team01\0${KAI}\0${5}\0`);
      const ctxB = Buffer.from(`agentteams-segment-v1\0team02\0${KAI}\0${5}\0`);
      const blob = encrypt(teamKey, Buffer.concat([sign(kai.privateKey, Buffer.concat([ctxA, pt])), pt]), ctxB);
      expect(decodeSegment(blob, teamKey, at(KAI, 5, 'team02'), lookup)).toEqual({ ok: false, reason: 'bad-signature' });
    });
    it("wrong-ref replay: kai's blob found under mia's ref is rejected", () => {
      expect(decodeSegment(buf, teamKey, at(MIA, 5), lookup).ok).toBe(false);
    });
    it('wrong-seq replay: blob found under another seq is rejected', () => {
      expect(decodeSegment(buf, teamKey, at(KAI, 9), lookup).ok).toBe(false);
      expect(decodeSegment(buf, teamKey, at(KAI, 5), lookup).ok).toBe(true);
    });
    it("'context' when the signed content disagrees with the expected location", () => {
      const loc = at(MIA, 1);
      const blob = forge(JSON.stringify({ v: 1, agent: KAI, seq: 1, ops: [] }), loc);
      expect(decodeSegment(blob, teamKey, loc, lookup)).toEqual({ ok: false, reason: 'context' });
      const blob2 = forge(JSON.stringify({ v: 1, agent: KAI, seq: 2, ops: [] }), at(KAI, 1));
      expect(decodeSegment(blob2, teamKey, at(KAI, 1), lookup)).toEqual({ ok: false, reason: 'context' });
    });
    it('invalid expected location is a context failure, not a throw', () => {
      expect(decodeSegment(buf, teamKey, at('bad id', 5), lookup)).toEqual({ ok: false, reason: 'context' });
      expect(decodeSegment(buf, teamKey, at(KAI, -1), lookup)).toEqual({ ok: false, reason: 'context' });
    });
  });

  it('rejects malformed content inside valid encryption', () => {
    const bad = { ok: false, reason: 'malformed' };
    const d = (b: Buffer) => decodeSegment(b, teamKey, at(KAI, 1), lookup);
    expect(d(forge('not json'))).toEqual(bad);
    expect(d(forge('[1]'))).toEqual(bad);
    expect(d(forge(`{"v":1,"agent":"${KAI}"}`))).toEqual(bad);
    expect(d(forge(`{"v":1,"agent":"${KAI}","seq":1,"ops":[{"x":1}]}`))).toEqual(bad);
    expect(d(forge(`{"v":1,"agent":"${KAI}","seq":-7,"ops":[]}`))).toEqual(bad);
    expect(d(forge(`{"v":1,"agent":"${KAI}","seq":1.5,"ops":[]}`))).toEqual(bad);
    expect(d(forge(`{"v":1,"agent":"${KAI}","seq":${2 ** 60},"ops":[]}`))).toEqual(bad);
    expect(d(encrypt(teamKey, Buffer.alloc(10), Buffer.from(`agentteams-segment-v1\0${TEAM}\0${KAI}\0${1}\0`)))).toEqual(bad);
  });
  it('rejects an op whose agent differs from the signer', () => {
    const body = JSON.stringify({ v: 1, agent: KAI, seq: 1, ops: [op(MIA, 1)] });
    expect(decodeSegment(forge(body), teamKey, at(KAI, 1), lookup)).toEqual({ ok: false, reason: 'malformed' });
  });
  it('rejects unsupported versions', () => {
    const body = `{"v":2,"agent":"${KAI}","seq":1,"ops":[]}`;
    expect(decodeSegment(forge(body), teamKey, at(KAI, 1), lookup)).toEqual({ ok: false, reason: 'version' });
  });

  describe('never throws', () => {
    it('hostile agent ids, including prototype keys, are rejected or unknown', () => {
      for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty0', 'a'.repeat(100), '', 'x y z']) {
        const body = JSON.stringify({ v: 1, agent: id, seq: 1, ops: [] });
        const res = decodeSegment(forge(body), teamKey, at(KAI, 1), lookup);
        expect(res.ok).toBe(false);
      }
    });
    it('plain-object lookup with prototype key does not throw', () => {
      const obj: Record<string, string> = { [KAI]: kai.publicKey };
      const blob = forge(JSON.stringify({ v: 1, agent: 'constructor', seq: 1, ops: [] }), at('constructor', 1));
      expect(decodeSegment(blob, teamKey, at('constructor', 1), (id) => obj[id]).ok).toBe(false);
    });
    it('a throwing lookup yields unknown-agent', () => {
      const buf = enc(KAI, 1, []);
      const res = decodeSegment(buf, teamKey, at(KAI, 1), () => {
        throw new Error('db down');
      });
      expect(res).toEqual({ ok: false, reason: 'unknown-agent' });
    });
    it('a garbage registered key is a bad signature', () => {
      const buf = enc(KAI, 1, []);
      expect(decodeSegment(buf, teamKey, at(KAI, 1), () => 'garbage')).toEqual({ ok: false, reason: 'bad-signature' });
      expect(decodeSegment(buf, teamKey, at(KAI, 1), (() => 42) as never)).toEqual({ ok: false, reason: 'bad-signature' });
    });
    it('non-buffer input is malformed', () => {
      expect(decodeSegment('x' as never, teamKey, at(KAI, 1), lookup)).toEqual({ ok: false, reason: 'malformed' });
    });
  });

  describe('limits', () => {
    it('rejects oversize blobs before decrypting', () => {
      expect(decodeSegment(Buffer.alloc(MAX_SEGMENT_BYTES + 1), teamKey, at(KAI, 1), lookup)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    });
    it('encode refuses too many ops and oversize segments', () => {
      const many = Array.from({ length: MAX_OPS_PER_SEGMENT + 1 }, (_, i) => op(KAI, i));
      expect(() => enc(KAI, 1, many)).toThrow(/too many ops/);
      const fat: Op = { ...op(KAI, 1), input: 'x'.repeat(MAX_SEGMENT_BYTES) };
      expect(() => enc(KAI, 1, [fat])).toThrow(/exceeds/);
      expect(enc(KAI, 1, Array.from({ length: MAX_OPS_PER_SEGMENT }, (_, i) => op(KAI, i)))).toBeInstanceOf(Buffer);
    });
    it('decode rejects too many ops even when validly signed', () => {
      const ops = Array.from({ length: MAX_OPS_PER_SEGMENT + 1 }, (_, i) => op(KAI, i));
      const blob = forge(JSON.stringify({ v: 1, agent: KAI, seq: 1, ops }));
      expect(decodeSegment(blob, teamKey, at(KAI, 1), lookup)).toEqual({ ok: false, reason: 'malformed' });
    });
    it('encode rejects bad agent ids and seq', () => {
      expect(() => enc('short', 1, [])).toThrow(/agent/);
      expect(() => enc(KAI, -1, [])).toThrow(/seq/);
    });
  });

  describe('join bootstrap (trust on first use)', () => {
    const NEW = 'new0000000N3';
    const fresh = newAgentKeyPair();
    const joinOp = (opName = 'join', publicKey: unknown = fresh.publicKey): Op => ({ ...op(NEW, 0), op: opName, input: { publicKey } });
    const none = () => undefined;

    it('verifies against the embedded key and returns it', () => {
      for (const name of ['join', 'createTeam']) {
        const res = decodeSegment(enc(NEW, 0, [joinOp(name), op(NEW, 1)], fresh.privateKey), teamKey, at(NEW, 0), none);
        expect(res.ok && res.bootstrapKey).toBe(fresh.publicKey);
      }
    });
    it('does not report a bootstrap key when the agent is already registered', () => {
      keys.set(NEW, fresh.publicKey);
      const res = decodeSegment(enc(NEW, 0, [joinOp()], fresh.privateKey), teamKey, at(NEW, 0), lookup);
      keys.delete(NEW);
      expect(res.ok).toBe(true);
      expect(res.ok && res.bootstrapKey).toBeUndefined();
    });
    it('rejects when signed by a key other than the embedded one', () => {
      const res = decodeSegment(enc(NEW, 0, [joinOp()], mia.privateKey), teamKey, at(NEW, 0), none);
      expect(res).toEqual({ ok: false, reason: 'bad-signature' });
    });
    it('is unknown-agent unless seq 0, first op join/createTeam, and a valid key', () => {
      const unk = { ok: false, reason: 'unknown-agent' };
      expect(decodeSegment(enc(NEW, 1, [joinOp()], fresh.privateKey), teamKey, at(NEW, 1), none)).toEqual(unk);
      expect(decodeSegment(enc(NEW, 0, [joinOp('sendMessage')], fresh.privateKey), teamKey, at(NEW, 0), none)).toEqual(unk);
      expect(decodeSegment(enc(NEW, 0, [op(NEW, 1), joinOp()], fresh.privateKey), teamKey, at(NEW, 0), none)).toEqual(unk);
      expect(decodeSegment(enc(NEW, 0, [joinOp('join', 'nope')], fresh.privateKey), teamKey, at(NEW, 0), none)).toEqual(unk);
      expect(decodeSegment(enc(NEW, 0, [joinOp('join', 5)], fresh.privateKey), teamKey, at(NEW, 0), none)).toEqual(unk);
      expect(decodeSegment(enc(NEW, 0, [], fresh.privateKey), teamKey, at(NEW, 0), none)).toEqual(unk);
    });
  });
});
