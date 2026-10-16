import { SIGNATURE_LEN, decrypt, encrypt, sign, verify } from './crypto.js';

export interface Op {
  v: 1;
  id: string;
  ts: string;
  agent: string;
  op: string;
  input: unknown;
}

export interface Segment {
  v: 1;
  agent: string;
  seq: number;
  ops: Op[];
}

export type RejectReason = 'decrypt' | 'malformed' | 'unknown-agent' | 'bad-signature' | 'version';

export type DecodeResult = { ok: true; segment: Segment } | { ok: false; reason: RejectReason };

/**
 * Wire format: AES-256-GCM( signature(64) | plaintext ) as nonce|tag|ct,
 * where plaintext = JSON {v:1, agent, seq, ops} and the Ed25519 signature
 * covers the plaintext bytes. segment.agent must be the signer.
 */
export function encodeSegment(
  segment: { agent: string; seq: number; ops: Op[] },
  teamKey: string,
  agentPrivateKey: string,
): Buffer {
  const plaintext = Buffer.from(JSON.stringify({ v: 1, agent: segment.agent, seq: segment.seq, ops: segment.ops }), 'utf8');
  return encrypt(teamKey, Buffer.concat([sign(agentPrivateKey, plaintext), plaintext]));
}

export function decodeSegment(
  buf: Buffer,
  teamKey: string,
  lookupPublicKey: (agentId: string) => string | undefined,
): DecodeResult {
  const inner = decrypt(teamKey, buf);
  if (!inner) return { ok: false, reason: 'decrypt' };
  if (inner.length <= SIGNATURE_LEN) return { ok: false, reason: 'malformed' };
  const signature = inner.subarray(0, SIGNATURE_LEN);
  const plaintext = inner.subarray(SIGNATURE_LEN);

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'malformed' };
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return { ok: false, reason: typeof p.v === 'number' ? 'version' : 'malformed' };
  if (typeof p.agent !== 'string' || p.agent === '' || !Number.isInteger(p.seq) || !Array.isArray(p.ops)) {
    return { ok: false, reason: 'malformed' };
  }

  const publicKey = lookupPublicKey(p.agent);
  if (!publicKey) return { ok: false, reason: 'unknown-agent' };
  if (!verify(publicKey, plaintext, signature)) return { ok: false, reason: 'bad-signature' };

  // Signature is valid; still check each op is well formed and authored by the signer.
  const agent = p.agent;
  if (!p.ops.every((o) => isOp(o, agent))) return { ok: false, reason: 'malformed' };
  return { ok: true, segment: { v: 1, agent, seq: p.seq as number, ops: p.ops as Op[] } };
}

function isOp(o: unknown, agent: string): o is Op {
  if (typeof o !== 'object' || o === null) return false;
  const r = o as Record<string, unknown>;
  return r.v === 1 && typeof r.id === 'string' && typeof r.ts === 'string' && r.agent === agent && typeof r.op === 'string';
}
