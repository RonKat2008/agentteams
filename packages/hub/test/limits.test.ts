import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientIp, createTokenBucket } from '../src/http/limits.js';

describe('createTokenBucket', () => {
  it('allows 60 per minute then refuses with a retry hint, and refills over time', () => {
    let t = 0;
    const bucket = createTokenBucket(60, () => t);
    for (let i = 0; i < 60; i++) expect(bucket.take('a')).toEqual({ ok: true });
    const refused = bucket.take('a');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterSec).toBeGreaterThan(0);
    expect(bucket.take('b')).toEqual({ ok: true });
    t += 1000; // 1 token per second at 60/min
    expect(bucket.take('a')).toEqual({ ok: true });
    expect(bucket.take('a').ok).toBe(false);
    t += 120_000; // fully refilled, capped at capacity
    for (let i = 0; i < 60; i++) expect(bucket.take('a')).toEqual({ ok: true });
    expect(bucket.take('a').ok).toBe(false);
  });
});

async function ipFor(mode: 'local' | 'hosted', headers: Record<string, string>): Promise<string> {
  const app = new Hono();
  app.get('/', (c) => c.text(clientIp(c, mode)));
  return (await app.request('/', { headers })).text();
}

describe('clientIp', () => {
  it('hosted prefers Fly-Client-IP, then the first X-Forwarded-For entry', async () => {
    expect(await ipFor('hosted', { 'fly-client-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' })).toBe('1.1.1.1');
    expect(await ipFor('hosted', { 'x-forwarded-for': '2.2.2.2, 3.3.3.3' })).toBe('2.2.2.2');
  });
  it('local ignores both headers', async () => {
    expect(await ipFor('local', { 'fly-client-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' })).toBe('unknown');
  });
});
