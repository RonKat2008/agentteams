import { describe, expect, it } from 'vitest';
import { parsePort } from '../src/config.js';

describe('parsePort', () => {
  it('defaults to 4747 when unset', () => {
    expect(parsePort(undefined)).toBe(4747);
  });
  it('parses a valid port', () => {
    expect(parsePort('4799')).toBe(4799);
  });
  it.each(['abc', '', '0', '70000', '12.5'])('rejects %j', (value) => {
    expect(() => parsePort(value)).toThrow(`AGENTTEAMS_PORT must be an integer between 1 and 65535 (got "${value}")`);
  });
});
