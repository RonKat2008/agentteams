import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientIp, createTokenBucket, normalizeIp, type IpSource } from '../src/http/limits.js';

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

async function ipFor(mode: 'local' | 'hosted', headers: Record<string, string>, source?: IpSource): Promise<string> {
  const app = new Hono();
  app.get('/', (c) => c.text(clientIp(c, mode, source)));
  return (await app.request('/', { headers })).text();
}

describe('clientIp', () => {
  it('vercel source uses the first x-vercel-forwarded-for entry, then x-real-ip, never Fly/XFF', async () => {
    expect(await ipFor('hosted', { 'x-vercel-forwarded-for': '4.4.4.4, 5.5.5.5', 'x-real-ip': '6.6.6.6' }, 'vercel')).toBe('4.4.4.4');
    expect(await ipFor('hosted', { 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '2.2.2.2' }, 'vercel')).toBe('6.6.6.6');
    expect(await ipFor('hosted', { 'fly-client-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }, 'vercel')).toBe('unknown');
  });
  it('fly source uses fly-client-ip only', async () => {
    expect(await ipFor('hosted', { 'fly-client-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }, 'fly')).toBe('1.1.1.1');
    expect(await ipFor('hosted', { 'x-forwarded-for': '2.2.2.2', 'x-vercel-forwarded-for': '4.4.4.4' }, 'fly')).toBe('unknown');
  });
  it('a configured header source uses the LAST comma entry (appending proxies add the real client last)', async () => {
    expect(await ipFor('hosted', { 'x-client': '9.9.9.9, 3.3.3.3', 'x-forwarded-for': '2.2.2.2' }, { header: 'x-client' })).toBe('3.3.3.3');
  });
  it('socket source (the hosted default) ignores every forwarding header, so spoofing makes no new bucket', async () => {
    const spoof = { 'x-vercel-forwarded-for': '4.4.4.4', 'x-real-ip': '6.6.6.6', 'fly-client-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' };
    expect(await ipFor('hosted', spoof)).toBe('unknown');
    expect(await ipFor('hosted', { ...spoof, 'x-vercel-forwarded-for': '8.8.8.8' })).toBe(await ipFor('hosted', spoof));
  });
  it('local ignores all headers even with a source', async () => {
    expect(await ipFor('local', { 'fly-client-ip': '1.1.1.1', 'x-vercel-forwarded-for': '4.4.4.4' }, 'fly')).toBe('unknown');
  });
});

describe('token bucket memory', () => {
  it('evicts the least recently used key beyond the cap', () => {
    const bucket = createTokenBucket(1, () => 0, 3);
    for (const k of ['a', 'b', 'c']) bucket.take(k);
    bucket.take('a'); // a is now most recent; b is oldest
    bucket.take('d');
    expect(bucket.size()).toBe(3);
    expect(bucket.take('a').ok).toBe(false); // a kept its spent bucket
    expect(bucket.take('b')).toEqual({ ok: true }); // b was evicted, so it starts fresh
  });
  it('prunes fully refilled buckets periodically', () => {
    let t = 0;
    const bucket = createTokenBucket(60, () => t);
    for (let i = 0; i < 500; i++) bucket.take(`k${i}`);
    t += 120_000;
    for (let i = 0; i < 500; i++) bucket.take('same');
    expect(bucket.size()).toBe(1);
  });
});

describe('normalizeIp', () => {
  it('buckets IPv6 by /64 and leaves IPv4 alone', () => {
    expect(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(normalizeIp('2001:db8:1:2::1'));
    expect(normalizeIp('2001:db8:1:3::1')).not.toBe(normalizeIp('2001:db8:1:2::1'));
    expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4');
  });
});
