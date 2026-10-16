import type { Context } from 'hono';
import { isIPv6 } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';

const MS_PER_MIN = 60_000;
const PRUNE_EVERY = 1_000;
const MAX_ENTRIES = 50_000;

export type TakeResult = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * In-memory token bucket: capacity `perMin`, refilled continuously at `perMin` tokens per minute.
 * State is per process, which is fine for a single hub instance; run several instances and each
 * enforces its own limit.
 */
export function createTokenBucket(
  perMin: number,
  now: () => number,
  maxEntries = MAX_ENTRIES,
): { take(key: string): TakeResult; size(): number } {
  // Insertion order doubles as LRU order: every take() re-inserts its key at the end.
  const buckets = new Map<string, { tokens: number; at: number }>();
  let calls = 0;
  const perMs = perMin / MS_PER_MIN;

  const refilled = (b: { tokens: number; at: number }, t: number) => Math.min(perMin, b.tokens + (t - b.at) * perMs);

  return {
    size: () => buckets.size,
    take(key) {
      const t = now();
      if (++calls % PRUNE_EVERY === 0) {
        for (const [k, b] of buckets) if (refilled(b, t) >= perMin) buckets.delete(k);
      }
      const prev = buckets.get(key);
      buckets.delete(key);
      while (buckets.size >= maxEntries) buckets.delete(buckets.keys().next().value as string);
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

/** IPv6 clients control a whole /64, so bucket by that prefix; IPv4 (and unparseable) values pass through. */
export function normalizeIp(ip: string): string {
  if (!isIPv6(ip) || ip.toLowerCase().startsWith('::ffff:')) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const groups = ip.includes('::')
    ? [...headGroups, ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups]
    : headGroups;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Client address for rate limiting. Forwarding headers are trusted only in hosted mode (behind the
 * platform proxy); locally they are attacker-controlled, so the socket address is used.
 *
 * SECURITY: hosted mode trusts Fly-Client-IP / X-Forwarded-For exactly as a fronting proxy sets them.
 * The hub must sit behind Fly (or a proxy that overwrites those headers); if it is reachable directly,
 * a client can spoof them and evade the per-IP limits. IPv6 addresses are reduced to their /64 prefix.
 */
export function clientIp(c: Context, mode: 'local' | 'hosted'): string {
  if (mode === 'hosted') {
    const fly = c.req.header('fly-client-ip')?.trim();
    if (fly) return normalizeIp(fly);
    const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (first) return normalizeIp(first);
  }
  try {
    const address = getConnInfo(c).remote.address;
    return address ? normalizeIp(address) : 'unknown';
  } catch {
    return 'unknown';
  }
}
