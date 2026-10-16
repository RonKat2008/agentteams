import { describe, expect, it } from 'vitest';
import { createHlc, formatHlc, parseHlc } from '../../src/git/hlc.js';

describe('hlc', () => {
  it('formats fixed-width and parses back', () => {
    const ts = formatHlc(Date.UTC(2026, 9, 16, 21), 1);
    expect(ts).toBe('2026-10-16T21:00:00.000Z-0001');
    expect(parseHlc(ts)).toEqual({ ms: Date.UTC(2026, 9, 16, 21), counter: 1 });
    expect(parseHlc('garbage')).toBeNull();
  });
  it('counts within the same millisecond', () => {
    const h = createHlc(() => 1_000);
    expect([h.tick(), h.tick()]).toEqual([formatHlc(1_000, 0), formatHlc(1_000, 1)]);
  });
  it('stays monotonic when the clock goes backwards', () => {
    let now = 5_000;
    const h = createHlc(() => now);
    const a = h.tick();
    now = 1_000;
    const b = h.tick();
    expect(b > a).toBe(true);
    now = 9_000;
    expect(h.tick() > b).toBe(true);
  });
  it('jumps past an observed future timestamp', () => {
    const h = createHlc(() => 1_000);
    h.observe(formatHlc(50_000, 7));
    expect(h.tick()).toBe(formatHlc(50_000, 8));
  });
  it('ignores older and malformed remotes', () => {
    const h = createHlc(() => 10_000);
    const a = h.tick();
    h.observe(formatHlc(1, 0));
    h.observe('nonsense');
    expect(h.tick() > a).toBe(true);
  });
  it('merges counters on equal milliseconds', () => {
    const h = createHlc(() => 1_000);
    h.tick();
    h.observe(formatHlc(1_000, 40));
    expect(h.tick()).toBe(formatHlc(1_000, 41));
  });
  it('rolls over counter overflow into the next ms', () => {
    const h = createHlc(() => 1_000);
    h.observe(formatHlc(1_000, 9999));
    expect(h.tick()).toBe(formatHlc(1_001, 0));
  });
  it('string sort equals generation order', () => {
    let now = 100_000;
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
