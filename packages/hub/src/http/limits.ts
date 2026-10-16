import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

const MS_PER_MIN = 60_000;
const PRUNE_THRESHOLD = 10_000;

export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * In-memory token bucket: capacity `perMin`, refilled continuously at `perMin` tokens per minute.
 * State is per process, which is fine for a single hub instance; run several instances and each
 * enforces its own limit.
 */
export function createTokenBucket(perMin: number, now: () => number): { take(key: string): TakeResult } {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const perMs = perMin / MS_PER_MIN;

  const refilled = (b: { tokens: number; at: number }, t: number) => Math.min(perMin, b.tokens + (t - b.at) * perMs);

  return {
    take(key) {
      const t = now();
      if (buckets.size > PRUNE_THRESHOLD) {
        for (const [k, b] of buckets) if (refilled(b, t) >= perMin) buckets.delete(k);
      }
      const prev = buckets.get(key);
      const tokens = prev ? refilled(prev, t) : perMin;
      if (tokens >= 1) {
        buckets.set(key, { tokens: tokens - 1, at: t });
        return { ok: true };
      }
      buckets.set(key, { tokens, at: t });
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / perMs / 1000)) };
    },
  };
}

/**
 * Client address for rate limiting. Forwarding headers are trusted only in hosted mode (behind the
 * platform proxy); locally they are attacker-controlled, so the socket address is used.
 */
export function clientIp(c: Context, mode: 'local' | 'hosted'): string {
  if (mode === 'hosted') {
    const fly = c.req.header('fly-client-ip')?.trim();
    if (fly) return fly;
    const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (first) return first;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
