import { describe, expect, it } from 'vitest';
import { resolvePoolMax } from '../src/db/postgres.js';

describe('resolvePoolMax', () => {
  it('defaults to 10 locally and 3 on Vercel', () => {
    expect(resolvePoolMax({})).toBe(10);
    expect(resolvePoolMax({ VERCEL: '1' })).toBe(3);
  });
  it('PG_POOL_MAX overrides both', () => {
    expect(resolvePoolMax({ PG_POOL_MAX: '7' })).toBe(7);
    expect(resolvePoolMax({ VERCEL: '1', PG_POOL_MAX: '5' })).toBe(5);
  });
  it('rejects non-positive or non-integer values', () => {
    for (const v of ['0', '-2', '1.5', 'abc', ' ']) expect(() => resolvePoolMax({ PG_POOL_MAX: v })).toThrow(/PG_POOL_MAX/);
  });
});
