import { createHash } from 'node:crypto';
import { SIGNATURE_LEN, decrypt, encrypt, isKeyString, sign, verify } from './crypto.js';

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

/** Where a segment must live: team, author (ref) and sequence number (file). */
export interface SegmentLocation {
  teamId: string;
  agent: string;
  seq: number;
}

export type RejectReason = 'decrypt' | 'malformed' | 'unknown-agent' | 'bad-signature' | 'version' | 'context' | 'bootstrap';

export type DecodeResult =
  | { ok: true; segment: Segment; bootstrapKey?: string }
  | { ok: false; reason: RejectReason };

export const MAX_SEGMENT_BYTES = 1024 * 1024;
export const MAX_OPS_PER_SEGMENT = 500;
export const AGENT_ID_RE = /^[0-9A-Za-z]{10,40}$/;
const CONTEXT_TAG = 'agentteams-segment-v1';
/** Ops allowed to introduce an agent's public key (trust on first use). */
const BOOTSTRAP_OPS = new Set(['join', 'createTeam']);

function isSeq(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/** Domain-separated context: used as the AES-GCM AAD and as the prefix of the signed bytes. */
function contextBytes(loc: SegmentLocation): Buffer {
  return Buffer.from(`${CONTEXT_TAG}\0${loc.teamId}\0${loc.agent}\0${loc.seq}\0`, 'utf8');
}

/**
 * Wire format: AES-256-GCM(sig(64) | plaintext) as nonce|tag|ct, with AAD = context, where
 *   plaintext = JSON {v:1, agent, seq, ops}
 *   signed bytes = context | plaintext, context = "agentteams-segment-v1\0teamId\0agent\0seq\0".
 * Throws on programmer error (bad ids, oversize); decode never throws.
 */
export function encodeSegment(
  segment: SegmentLocation & { ops: Op[] },
  teamKey: string,
  agentPrivateKey: string,
): Buffer {
  if (!AGENT_ID_RE.test(segment.agent)) throw new Error('invalid agent id');
  if (!isSeq(segment.seq)) throw new Error('invalid seq');
  if (segment.ops.length > MAX_OPS_PER_SEGMENT) throw new Error(`too many ops (max ${MAX_OPS_PER_SEGMENT})`);
  const ctx = contextBytes(segment);
  const plaintext = Buffer.from(JSON.stringify({ v: 1, agent: segment.agent, seq: segment.seq, ops: segment.ops }), 'utf8');
  const sig = sign(agentPrivateKey, Buffer.concat([ctx, plaintext]));
  const out = encrypt(teamKey, Buffer.concat([sig, plaintext]), ctx);
  if (out.length > MAX_SEGMENT_BYTES) throw new Error(`segment exceeds ${MAX_SEGMENT_BYTES} bytes`);
  return out;
}

/**
 * Identity of a segment's signed content: sha256 of the decrypted bytes (signature | plaintext) at `loc`, or null
 * when it does not decrypt there. Ed25519 signatures are deterministic, so the same signed segment has the same
 * hash however many times it is re-encrypted (every member holds the team key and can re-encrypt). Equivocation is
 * decided on this, never on blob or ciphertext ids. Never throws.
 */
export function segmentContentHash(buf: Buffer, teamKey: string, loc: SegmentLocation): string | null {
  try {
    if (!Buffer.isBuffer(buf) || buf.length > MAX_SEGMENT_BYTES || !AGENT_ID_RE.test(loc.agent) || !isSeq(loc.seq)) return null;
    const inner = decrypt(teamKey, buf, contextBytes(loc));
    return inner ? createHash('sha256').update(inner).digest('hex') : null;
  } catch {
    return null;
  }
}

/**
 * Never throws. `expected` is where the blob was found; a blob whose bound context differs is
 * rejected ('decrypt' when the AAD differs, 'context' when the signed content disagrees).
 * If the author has no registered key, a seq-0 join/createTeam op carrying its own public key
 * is verified against that key and returned as `bootstrapKey` (trust on first use; the replay
 * layer enforces first-registration-wins).
 */
export function decodeSegment(
  buf: Buffer,
  teamKey: string,
  expected: SegmentLocation,
  lookupPublicKey: (agentId: string) => string | undefined,
): DecodeResult {
  try {
    return decodeUnsafe(buf, teamKey, expected, lookupPublicKey);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

function decodeUnsafe(
  buf: Buffer,
  teamKey: string,
  expected: SegmentLocation,
  lookupPublicKey: (agentId: string) => string | undefined,
): DecodeResult {
  if (!Buffer.isBuffer(buf) || buf.length > MAX_SEGMENT_BYTES) return { ok: false, reason: 'malformed' };
  if (!AGENT_ID_RE.test(expected.agent) || !isSeq(expected.seq)) return { ok: false, reason: 'context' };
  const ctx = contextBytes(expected);
  const inner = decrypt(teamKey, buf, ctx);
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
  if (typeof p.agent !== 'string' || !AGENT_ID_RE.test(p.agent) || !isSeq(p.seq) || !Array.isArray(p.ops)) {
    return { ok: false, reason: 'malformed' };
  }
  if (p.ops.length > MAX_OPS_PER_SEGMENT) return { ok: false, reason: 'malformed' };
  if (p.agent !== expected.agent || p.seq !== expected.seq) return { ok: false, reason: 'context' };

  const agent = p.agent;
  const seq = p.seq;
  const ops = p.ops;
  const signed = Buffer.concat([ctx, plaintext]);

  // Lookup contract: undefined = not registered (bootstrap allowed); a throw, null or a
  // non-string = reject; a string that is not a valid key fails signature verification.
  let registered: unknown;
  try {
    registered = lookupPublicKey(agent);
  } catch {
    return { ok: false, reason: 'unknown-agent' };
  }
  let bootstrapKey: string | undefined;
  let key: string;
  if (registered === undefined) {
    bootstrapKey = bootstrapKeyOf(seq, ops);
    if (!bootstrapKey) return { ok: false, reason: 'unknown-agent' };
    // A bootstrap segment is exactly one join/createTeam op, about this agent only.
    if (ops.length !== 1 || !bootstrapIdMatches(ops[0], agent)) return { ok: false, reason: 'bootstrap' };
    key = bootstrapKey;
  } else if (typeof registered === 'string') {
    key = registered;
  } else {
    return { ok: false, reason: 'unknown-agent' };
  }
  if (!verify(key, signed, signature)) return { ok: false, reason: 'bad-signature' };

  if (!ops.every((o) => isOp(o, agent))) return { ok: false, reason: 'malformed' };
  // join/createTeam may only appear in a bootstrap segment.
  if (!bootstrapKey && ops.some((o) => BOOTSTRAP_OPS.has((o as Op).op))) return { ok: false, reason: 'bootstrap' };
  const segment: Segment = { v: 1, agent, seq, ops: ops as Op[] };
  return bootstrapKey ? { ok: true, segment, bootstrapKey } : { ok: true, segment };
}

function bootstrapIdMatches(op: unknown, agent: string): boolean {
  const input = (op as { input?: Record<string, unknown> }).input;
  const id = input?.agentId;
  return id === undefined || id === agent;
}

function bootstrapKeyOf(seq: number, ops: unknown[]): string | undefined {
  if (seq !== 0) return undefined;
  const first = ops[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const o = first as Record<string, unknown>;
  if (typeof o.op !== 'string' || !BOOTSTRAP_OPS.has(o.op)) return undefined;
  const input = o.input;
  if (typeof input !== 'object' || input === null) return undefined;
  const pk = (input as Record<string, unknown>).publicKey;
  return isKeyString(pk) ? pk : undefined;
}

function isOp(o: unknown, agent: string): o is Op {
  if (typeof o !== 'object' || o === null) return false;
  const r = o as Record<string, unknown>;
  return r.v === 1 && typeof r.id === 'string' && typeof r.ts === 'string' && r.agent === agent && typeof r.op === 'string';
}
