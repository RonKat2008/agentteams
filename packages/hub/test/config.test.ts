import { describe, expect, it } from 'vitest';
import { parsePort, resolveHome } from '../src/config.js';

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

describe('resolveHome', () => {
  it('defaults when unset or empty', () => {
    expect(resolveHome(undefined, '/h')).toBe('/h/.agentteams');
    expect(resolveHome('', '/h')).toBe('/h/.agentteams');
  });
  it('accepts an absolute path', () => {
    expect(resolveHome('/data/at', '/h')).toBe('/data/at');
  });
  it('rejects a relative path', () => {
    expect(() => resolveHome('rel/dir', '/h')).toThrow('AGENTTEAMS_HOME must be an absolute path');
  });
});
