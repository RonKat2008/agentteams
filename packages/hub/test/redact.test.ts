import { describe, expect, it } from 'vitest';
import { redact } from '../src/redact.js';

describe('redact', () => {
  it('replaces postgres and postgresql URLs', () => {
    expect(redact('bad postgres://u:pw@h:5432/db?ssl=1 here')).toBe('bad postgres://*** here');
    expect(redact('x postgresql://u:pw@h/db')).toBe('x postgres://***');
    expect(redact('POSTGRES://u:pw@h/db')).toBe('postgres://***');
  });
  it('leaves other text alone', () => {
    expect(redact('connection refused')).toBe('connection refused');
  });
});
