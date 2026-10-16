import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from 'node:crypto';

/**
 * Pure crypto helpers for the git transport. Only node:crypto.
 *
 * Key formats (all base64url strings, no padding):
 * - team key: 32 random bytes.
 * - Ed25519 public key: the raw 32 bytes.
 * - Ed25519 private key: the raw 32-byte seed.
 */

const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
export const SIGNATURE_LEN = 64;

// DER prefixes that wrap a raw 32-byte Ed25519 key.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface AgentKeyPair {
  publicKey: string;
  privateKey: string;
}

export function newTeamKey(): string {
  return randomBytes(KEY_LEN).toString('base64url');
}

function keyBytes(key: string): Buffer {
  const buf = Buffer.from(key, 'base64url');
  if (buf.length !== KEY_LEN) throw new Error(`key must be ${KEY_LEN} bytes`);
  return buf;
}

/** Output layout: nonce(12) | tag(16) | ciphertext. */
export function encrypt(teamKey: string, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(teamKey), nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]);
}

/** Returns null when the key is wrong or any byte was altered. Never throws. */
export function decrypt(teamKey: string, data: Buffer): Buffer | null {
  if (data.length < NONCE_LEN + TAG_LEN) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(teamKey), data.subarray(0, NONCE_LEN));
    decipher.setAuthTag(data.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN));
    return Buffer.concat([decipher.update(data.subarray(NONCE_LEN + TAG_LEN)), decipher.final()]);
  } catch {
    return null;
  }
}

export function newAgentKeyPair(): AgentKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(SPKI_PREFIX.length).toString('base64url'),
    privateKey: (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).subarray(PKCS8_PREFIX.length).toString('base64url'),
  };
}

function publicKeyObject(publicKey: string): KeyObject | null {
  const raw = Buffer.from(publicKey, 'base64url');
  if (raw.length !== KEY_LEN) return null;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** Ed25519 signature (64 bytes) over data. */
export function sign(privateKey: string, data: Buffer): Buffer {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, keyBytes(privateKey)]), format: 'der', type: 'pkcs8' });
  return nodeSign(null, data, key);
}

/** False for any bad signature or malformed key; never throws. */
export function verify(publicKey: string, data: Buffer, signature: Buffer): boolean {
  const key = publicKeyObject(publicKey);
  if (!key || signature.length !== SIGNATURE_LEN) return false;
  try {
    return nodeVerify(null, data, key, signature);
  } catch {
    return false;
  }
}
