/**
 * presence.bin: an agent's "I am here" heartbeat, overwritten in its log tree (never an op).
 *
 * Wire format like a segment: AES-256-GCM(sig(64) | JSON) under the team key, AAD = context, where the signature is
 * the agent's over context | JSON, context = "agentteams-presence-v2\0<teamId>\0<agentId>\0" and
 * JSON = {v: 2, agent, ts, counter}. Replicas accept a presence only when (ts, counter) is newer than the last one they
 * accepted for that agent, so a replayed old blob is refused. The writer uses ts = max(now, last.ts) and
 * counter = last.counter + 1, so its own presence is always newer, even after its clock moved backwards.
 */
import { SIGNATURE_LEN, decrypt, encrypt, sign, verify } from './crypto.js';

export interface Presence { ts: number; counter: number }

const PRESENCE_TAG = 'agentteams-presence-v2';
const context = (teamId: string, agent: string) => Buffer.from(`${PRESENCE_TAG}\0${teamId}\0${agent}\0`, 'utf8');
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export function encodePresence(
  git: { teamId: string; agentId: string; teamKey: string; privateKey: string }, p: Presence,
): Buffer {
  if (!isCount(p.ts) || !isCount(p.counter)) throw new Error('invalid presence');
  const ctx = context(git.teamId, git.agentId);
  const plaintext = Buffer.from(JSON.stringify({ v: 2, agent: git.agentId, ts: p.ts, counter: p.counter }), 'utf8');
  return encrypt(git.teamKey, Buffer.concat([sign(git.privateKey, Buffer.concat([ctx, plaintext])), plaintext]), ctx);
}

/** The presence, or null if it does not decrypt, verify or parse. Never throws. */
export function decodePresence(buf: Buffer, teamKey: string, teamId: string, agent: string, publicKey: string): Presence | null {
  try {
    const ctx = context(teamId, agent);
    const inner = decrypt(teamKey, buf, ctx);
    if (!inner || inner.length <= SIGNATURE_LEN) return null;
    const plaintext = inner.subarray(SIGNATURE_LEN);
    if (!verify(publicKey, Buffer.concat([ctx, plaintext]), inner.subarray(0, SIGNATURE_LEN))) return null;
    const p = JSON.parse(plaintext.toString('utf8')) as { v?: unknown; agent?: unknown; ts?: unknown; counter?: unknown };
    if (p.v !== 2 || p.agent !== agent || !isCount(p.ts) || !isCount(p.counter)) return null;
    return { ts: p.ts, counter: p.counter };
  } catch {
    return null;
  }
}

/** True when `a` is newer than `b` (lexicographic on (ts, counter)); anything is newer than nothing. */
export const isNewer = (a: Presence, b: Presence | undefined): boolean =>
  !b || a.ts > b.ts || (a.ts === b.ts && a.counter > b.counter);

/** The next presence to write after `last`: never older, whatever the clock says. */
export const nextPresence = (now: number, last: Presence | undefined): Presence =>
  ({ ts: Math.max(Math.floor(now), last?.ts ?? 0), counter: (last?.counter ?? 0) + 1 });
