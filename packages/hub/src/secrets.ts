import { createHash, randomBytes } from 'node:crypto';

// 32 symbols (no l, o, 0, 1) → 5 bits each; 16 symbols = 80 bits.
const INVITE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const INVITE_LENGTH = 16;

export function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_LENGTH);
  let code = '';
  for (const byte of bytes) code += INVITE_ALPHABET[byte & 31];
  return code.match(/.{4}/g)!.join('-');
}

export function normalizeInviteCode(code: string): string {
  return code.trim().toLowerCase();
}

export function generateApiKey(): string {
  return `at_${randomBytes(32).toString('base64url')}`;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}
