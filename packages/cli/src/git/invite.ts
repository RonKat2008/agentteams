/**
 * Git-team invite code: `at1-` + base32 (RFC 4648 alphabet, lowercase, no padding) of
 *   key(32 bytes) | teamIdLen(1) | teamId(utf8) | remote(utf8, rest)
 * One token with no separators, as short as the content allows.
 */

export const INVITE_PREFIX = 'at1-';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const KEY_LEN = 32;
const MAX_TEAM_ID = 64;
const MAX_REMOTE = 512;
const MAX_CODE = INVITE_PREFIX.length + Math.ceil(((KEY_LEN + 1 + MAX_TEAM_ID + MAX_REMOTE) * 8) / 5);
const TEAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface Invite {
  remote: string;
  teamId: string;
  /** base64url team key (32 bytes) */
  key: string;
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
  // Leftover bits must be zero padding (canonical encoding).
  if ((value & ((1 << bits) - 1)) !== 0) return null;
  return Buffer.from(out);
}

/** https://, ssh://, scp-like git@host:path, file://, or an absolute path (the last two mostly for tests). */
export function isValidRemote(remote: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (remote.length === 0 || remote.length > MAX_REMOTE || /[\s\x00-\x1f]/.test(remote)) return false;
  if (/^(https|ssh):\/\/[^/\s]+(\/.*)?$/.test(remote)) return true;
  if (/^file:\/\/.+/.test(remote)) return true;
  if (/^git@[A-Za-z0-9._-]+:\S+$/.test(remote)) return true;
  return remote.startsWith('/') && remote.length > 1;
}

export function encodeInvite(invite: Invite): string {
  const key = Buffer.from(invite.key, 'base64url');
  if (key.length !== KEY_LEN) throw new InviteError(`team key must be ${KEY_LEN} bytes`);
  if (!TEAM_ID_RE.test(invite.teamId) || invite.teamId.length > MAX_TEAM_ID) throw new InviteError('invalid team id');
  if (!isValidRemote(invite.remote)) throw new InviteError(`unsupported remote "${invite.remote}"`);
  const id = Buffer.from(invite.teamId, 'utf8');
  const payload = Buffer.concat([key, Buffer.from([id.length]), id, Buffer.from(invite.remote, 'utf8')]);
  return INVITE_PREFIX + base32Encode(payload);
}

/** Throws InviteError with a readable message on anything malformed. */
export function decodeInvite(code: string): Invite {
  const trimmed = code.trim();
  if (!trimmed.startsWith(INVITE_PREFIX)) {
    throw new InviteError(`not an agentteams invite code (expected it to start with "${INVITE_PREFIX}")`);
  }
  if (trimmed.length > MAX_CODE) throw new InviteError('invite code is too long');
  const body = trimmed.slice(INVITE_PREFIX.length);
  if (body.length === 0) throw new InviteError('invite code is empty after the prefix');
  const payload = base32Decode(body);
  if (!payload) throw new InviteError('invite code contains invalid characters');
  if (payload.length < KEY_LEN + 2) throw new InviteError('invite code is truncated');
  const idLen = payload[KEY_LEN]!;
  const idEnd = KEY_LEN + 1 + idLen;
  if (idLen === 0 || idLen > MAX_TEAM_ID || payload.length <= idEnd) throw new InviteError('invite code is truncated or corrupt');
  const teamId = payload.subarray(KEY_LEN + 1, idEnd).toString('utf8');
  if (!TEAM_ID_RE.test(teamId)) throw new InviteError('invite code has an invalid team id');
  const remote = payload.subarray(idEnd).toString('utf8');
  if (!isValidRemote(remote)) {
    throw new InviteError('invite code has an unsupported remote (use https://, ssh://, git@host:path, file:// or an absolute path)');
  }
  return { remote, teamId, key: payload.subarray(0, KEY_LEN).toString('base64url') };
}
