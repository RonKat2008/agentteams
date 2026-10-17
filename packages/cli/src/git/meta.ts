/**
 * The team meta ref (`refs/agentteams/<team>/meta`, file meta.bin): written once by the creator.
 * Wire format like a segment: AES-256-GCM(sig(64) | JSON) under the team key, AAD = context, where the signature
 * is the creator's over context | JSON and context = "agentteams-meta-v1\0<teamId>\0". The creator's key is in
 * the JSON (self-signed); trust comes from pinning it on first sight (replay.pinTeamMeta), and the pinned creator
 * is the only agent whose createTeam replay accepts.
 */
import { SIGNATURE_LEN, decrypt, encrypt, isKeyString, sign, verify } from './crypto.js';
import type { TeamMetaPin } from './replay.js';
import { AGENT_ID_RE } from './segment.js';

export interface TeamMeta {
  v: 1;
  teamId: string;
  name: string;
  createdAt: string;
  defaultBranch: string;
  /** The creator's agent id (= its createTeam op id) and signing key. */
  agentId: string;
  publicKey: string;
}

export const MAX_META_BYTES = 64 * 1024;

const context = (teamId: string) => Buffer.from(`agentteams-meta-v1\0${teamId}\0`, 'utf8');

export function encodeMeta(meta: Omit<TeamMeta, 'v'>, teamKey: string, creatorPrivateKey: string): Buffer {
  const ctx = context(meta.teamId);
  const plaintext = Buffer.from(JSON.stringify({ v: 1, ...meta }), 'utf8');
  return encrypt(teamKey, Buffer.concat([sign(creatorPrivateKey, Buffer.concat([ctx, plaintext])), plaintext]), ctx);
}

/** The verified meta of `teamId`, or null (wrong key or team, tampered, malformed). Never throws. */
export function decodeMeta(buf: Buffer, teamKey: string, teamId: string): TeamMeta | null {
  try {
    if (buf.length > MAX_META_BYTES) return null;
    const ctx = context(teamId);
    const inner = decrypt(teamKey, buf, ctx);
    if (!inner || inner.length <= SIGNATURE_LEN) return null;
    const plaintext = inner.subarray(SIGNATURE_LEN);
    const m = JSON.parse(plaintext.toString('utf8')) as Partial<TeamMeta>;
    if (m.v !== 1 || m.teamId !== teamId || typeof m.name !== 'string' || typeof m.createdAt !== 'string') return null;
    if (typeof m.defaultBranch !== 'string' || typeof m.agentId !== 'string' || !AGENT_ID_RE.test(m.agentId)) return null;
    if (!isKeyString(m.publicKey)) return null;
    if (!verify(m.publicKey, Buffer.concat([ctx, plaintext]), inner.subarray(0, SIGNATURE_LEN))) return null;
    return m as TeamMeta;
  } catch {
    return null;
  }
}

/** What is pinned locally for the team: the creator plus the descriptive fields. */
export function metaPin(m: TeamMeta): TeamMetaPin {
  return { agentId: m.agentId, publicKey: m.publicKey, name: m.name, createdAt: m.createdAt, defaultBranch: m.defaultBranch };
}
