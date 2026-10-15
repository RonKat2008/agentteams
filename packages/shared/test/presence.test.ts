import { describe, expect, it } from 'vitest';
import { presenceOf } from '@agentteams/shared';

const now = new Date('2026-01-01T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

describe('presenceOf', () => {
  it('is offline when never seen', () => {
    expect(presenceOf(null, now)).toBe('offline');
  });
  it('is active up to and including 60s', () => {
    expect(presenceOf(ago(0), now)).toBe('active');
    expect(presenceOf(ago(60_000), now)).toBe('active');
  });
  it('is idle after 60s up to 10 minutes', () => {
    expect(presenceOf(ago(60_001), now)).toBe('idle');
    expect(presenceOf(ago(600_000), now)).toBe('idle');
  });
  it('is offline after 10 minutes', () => {
    expect(presenceOf(ago(600_001), now)).toBe('offline');
  });
});
