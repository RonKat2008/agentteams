import { PRESENCE_ACTIVE_MS, PRESENCE_IDLE_MS } from './constants.js';
import type { PresenceStatus } from './schemas.js';

export function presenceOf(lastSeenAt: string | null, now: Date): PresenceStatus {
  if (lastSeenAt === null) return 'offline';
  const age = now.getTime() - new Date(lastSeenAt).getTime();
  if (age <= PRESENCE_ACTIVE_MS) return 'active';
  if (age <= PRESENCE_IDLE_MS) return 'idle';
  return 'offline';
}
