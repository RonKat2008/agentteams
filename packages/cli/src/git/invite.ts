/**
 * Git-team invite code: `at1-` + base32 (RFC 4648 alphabet, lowercase, no padding) of
 *   version(1) = 1 | key(32) | creatorPublicKey(32) | creatorIdLen(1) | creatorId(ascii) | teamIdLen(1) | teamId(utf8)
 *   | remote(utf8, rest)
 * One token with no separators, as short as the content allows. The creator (agent id and Ed25519 key) lets a
 * joiner pin the team's creator from the invite itself instead of trusting the meta ref on first sight.
 */

export const INVITE_PREFIX = 'at1-';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const PAYLOAD_VERSION = 1;
const KEY_LEN = 32;
const PUBLIC_KEY_LEN = 32;
const MAX_CREATOR_ID = 40;
const CREATOR_ID_RE = /^[0-9A-Za-z]{10,40}$/;
const MAX_TEAM_ID = 64;
const MAX_REMOTE = 512;
const FIXED_LEN = 1 + KEY_LEN + PUBLIC_KEY_LEN + 1;
export const MAX_INVITE_LENGTH =
  INVITE_PREFIX.length + Math.ceil(((FIXED_LEN + MAX_CREATOR_ID + 1 + MAX_TEAM_ID + MAX_REMOTE) * 8) / 5);
const TEAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The team's creator: its agent id (= its createTeam op id) and base64url Ed25519 public key (32 bytes). */
export interface InviteCreator { agentId: string; publicKey: string }

export interface Invite {
  remote: string;
  teamId: string;
  /** base64url team key (32 bytes) */
  key: string;
  creator: InviteCreator;
}

export class InviteError extends Error {}

function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  // Canonical encoding: fewer than 5 leftover bits, all zero.
  if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) return null;
  return Buffer.from(out);
}

const HOST = '[A-Za-z0-9][A-Za-z0-9.-]*';
const USER = '[A-Za-z0-9][A-Za-z0-9._-]*';
const URL_RE = new RegExp(`^(?:https|ssh)://(?:${USER}@)?${HOST}(?::\\d{1,5})?(/\\S*)?$`);
const SCP_RE = new RegExp(`^git@${HOST}:(\\S+)$`);
// Control, format (incl. bidi overrides U+202A-202E, U+2066-2069), separator and whitespace characters.
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Z}\s]/u;

/** No path segment may start with '-', which git could read as an option. */
function safeSegments(path: string): boolean {
  return path.split('/').every((seg) => !seg.startsWith('-'));
}

/** https://, ssh://, git@host:path, file:///path, or an absolute path (the last two mostly for tests). */
export function isValidRemote(remote: unknown): remote is string {
  if (typeof remote !== 'string' || remote.length === 0 || remote.length > MAX_REMOTE) return false;
  if (FORBIDDEN_CHARS.test(remote)) return false;
  const url = URL_RE.exec(remote);
  if (url) return safeSegments(url[1] ?? '');
  const scp = SCP_RE.exec(remote);
  if (scp) return safeSegments(scp[1]!);
  if (remote.startsWith('file:///')) return remote.length > 8 && safeSegments(remote.slice(7));
  return remote.startsWith('/') && remote.length > 1 && safeSegments(remote);
}

export function encodeInvite(invite: Invite): string {
  const key = Buffer.from(invite.key, 'base64url');
  if (key.length !== KEY_LEN) throw new InviteError(`team key must be ${KEY_LEN} bytes`);
  const pub = Buffer.from(invite.creator?.publicKey ?? '', 'base64url');
  if (pub.length !== PUBLIC_KEY_LEN || pub.toString('base64url') !== invite.creator.publicKey) {
    throw new InviteError(`creator public key must be ${PUBLIC_KEY_LEN} bytes of base64url`);
  }
  if (!CREATOR_ID_RE.test(invite.creator.agentId)) throw new InviteError('invalid creator agent id');
  if (!TEAM_ID_RE.test(invite.teamId) || invite.teamId.length > MAX_TEAM_ID) throw new InviteError('invalid team id');
  if (!isValidRemote(invite.remote)) throw new InviteError(`unsupported remote "${invite.remote}"`);
  const creatorId = Buffer.from(invite.creator.agentId, 'ascii');
  const id = Buffer.from(invite.teamId, 'utf8');
  const payload = Buffer.concat([
    Buffer.from([PAYLOAD_VERSION]), key, pub, Buffer.from([creatorId.length]), creatorId,
    Buffer.from([id.length]), id, Buffer.from(invite.remote, 'utf8'),
  ]);
  return INVITE_PREFIX + base32Encode(payload);
}

/** Throws InviteError with a readable message on anything malformed. */
export function decodeInvite(code: string): Invite {
  const trimmed = code.trim();
  if (!trimmed.startsWith(INVITE_PREFIX)) {
    throw new InviteError(`not an agentteams invite code (expected it to start with "${INVITE_PREFIX}")`);
  }
  if (trimmed.length > MAX_INVITE_LENGTH) throw new InviteError('invite code is too long');
  const body = trimmed.slice(INVITE_PREFIX.length);
  if (body.length === 0) throw new InviteError('invite code is empty after the prefix');
  const payload = base32Decode(body);
  if (!payload) throw new InviteError('invite code contains invalid characters');
  if (payload.length < FIXED_LEN + 2) throw new InviteError('invite code is truncated');
  if (payload[0] !== PAYLOAD_VERSION) throw new InviteError('invite code is from an unsupported version of agentteams');
  const key = payload.subarray(1, 1 + KEY_LEN).toString('base64url');
  const publicKey = payload.subarray(1 + KEY_LEN, 1 + KEY_LEN + PUBLIC_KEY_LEN).toString('base64url');
  const creatorLen = payload[FIXED_LEN - 1]!;
  const creatorEnd = FIXED_LEN + creatorLen;
  if (creatorLen === 0 || creatorLen > MAX_CREATOR_ID || payload.length <= creatorEnd + 1) {
    throw new InviteError('invite code is truncated or corrupt');
  }
  const agentId = payload.subarray(FIXED_LEN, creatorEnd).toString('latin1');
  if (!CREATOR_ID_RE.test(agentId)) throw new InviteError('invite code has an invalid creator id');
  const idLen = payload[creatorEnd]!;
  const idStart = creatorEnd + 1;
  const idEnd = idStart + idLen;
  if (idLen === 0 || idLen > MAX_TEAM_ID || payload.length <= idEnd) throw new InviteError('invite code is truncated or corrupt');
  const teamId = payload.subarray(idStart, idEnd).toString('utf8');
  if (!TEAM_ID_RE.test(teamId)) throw new InviteError('invite code has an invalid team id');
  let remote: string;
  try {
    remote = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload.subarray(idEnd));
  } catch {
    throw new InviteError('invite code has an invalid remote encoding');
  }
  if (!isValidRemote(remote)) {
    throw new InviteError('invite code has an unsupported remote (use https://, ssh://, git@host:path, file:// or an absolute path)');
  }
  return { remote, teamId, key, creator: { agentId, publicKey } };
}
