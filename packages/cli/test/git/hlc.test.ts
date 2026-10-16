import { describe, expect, it } from 'vitest';
import { MAX_CLOCK_SKEW_MS, MAX_HLC_MS, createHlc, formatHlc, parseHlc } from '../../src/git/hlc.js';

const T0 = Date.UTC(2026, 9, 16, 21);

describe('hlc', () => {
  it('formats fixed-width and parses back', () => {
    const ts = formatHlc(T0, 1);
    expect(ts).toBe('2026-10-16T21:00:00.000Z-0001');
    expect(parseHlc(ts)).toEqual({ ms: T0, counter: 1 });
    expect(parseHlc('garbage')).toBeNull();
    expect(parseHlc(5)).toBeNull();
  });
  it('rejects non-canonical dates and out-of-range years', () => {
    expect(parseHlc('2026-02-30T00:00:00.000Z-0000')).toBeNull();
    expect(parseHlc('2026-10-16T24:00:00.000Z-0000')).toBeNull();
    expect(parseHlc('1999-12-31T23:59:59.999Z-0000')).toBeNull();
    expect(parseHlc('9999-12-31T23:59:59.999Z-0000')).not.toBeNull();
  });
  it('clamps formatting into the valid year range', () => {
    expect(formatHlc(Number.MAX_SAFE_INTEGER, 0).startsWith('9999-12-31')).toBe(true);
    expect(formatHlc(0, 0).startsWith('2000-01-01')).toBe(true);
  });
  it('counts within the same millisecond', () => {
    const h = createHlc(() => T0);
    expect([h.tick(), h.tick()]).toEqual([formatHlc(T0, 0), formatHlc(T0, 1)]);
  });
  it('stays monotonic when the clock goes backwards', () => {
    let now = T0 + 5_000;
    const h = createHlc(() => now);
    const a = h.tick();
    now = T0 + 1_000;
    const b = h.tick();
    expect(b > a).toBe(true);
    now = T0 + 9_000;
    expect(h.tick() > b).toBe(true);
  });
  it('jumps past an observed (within-skew) future timestamp', () => {
    const h = createHlc(() => T0);
    expect(h.observe(formatHlc(T0 + 50_000, 7))).toBe(true);
    expect(h.tick()).toBe(formatHlc(T0 + 50_000, 8));
  });
  it('ignores remotes beyond the skew cap and malformed ones, accepts older ones', () => {
    const h = createHlc(() => T0);
    const a = h.tick();
    expect(h.observe(formatHlc(T0 + MAX_CLOCK_SKEW_MS + 1, 0))).toBe(false);
    expect(h.observe('nonsense')).toBe(false);
    expect(h.observe(formatHlc(T0 - 10_000, 0))).toBe(true);
    expect(h.observe(formatHlc(T0 + MAX_CLOCK_SKEW_MS, 0))).toBe(true);
    expect(h.tick() > a).toBe(true);
  });
  it('a far-future timestamp cannot wedge the clock', () => {
    const h = createHlc(() => T0);
    expect(h.observe(`${new Date(MAX_HLC_MS).toISOString()}-9999`)).toBe(false);
    expect(parseHlc(h.tick())).not.toBeNull();
  });
  it('merges counters on equal milliseconds', () => {
    const h = createHlc(() => T0);
    h.tick();
    h.observe(formatHlc(T0, 40));
    expect(h.tick()).toBe(formatHlc(T0, 41));
  });
  it('rolls over counter overflow into the next ms', () => {
    const h = createHlc(() => T0);
    h.observe(formatHlc(T0, 9999));
    expect(h.tick()).toBe(formatHlc(T0 + 1, 0));
  });
  it('string sort equals generation order', () => {
    let now = T0;
    const h = createHlc(() => now);
    const out: string[] = [];
    const steps = [0, 0, 1, -50, 0, 3000, -1, 0, 0, 12, -100000, 0];
    for (const d of steps) {
      now += d;
      out.push(h.tick());
      if (out.length === 6) h.observe(formatHlc(now + 9_000, 3));
    }
    expect([...out].sort()).toEqual(out);
    expect(new Set(out).size).toBe(out.length);
  });
});
