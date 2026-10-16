import { describe, expect, it } from 'vitest';
import { loadHubConfig, parsePort, resolveHome } from '../src/config.js';

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

describe('loadHubConfig', () => {
  it('has local defaults', () => {
    expect(loadHubConfig({}, '/h')).toEqual({
      mode: 'local', host: '127.0.0.1', port: 4747, home: '/h/.agentteams', databaseUrl: undefined,
      allowedHosts: ['127.0.0.1', 'localhost'],
    });
  });
  it('requires allowed hosts in hosted mode', () => {
    expect(() => loadHubConfig({ AGENTTEAMS_MODE: 'hosted' }, '/h')).toThrow('AGENTTEAMS_ALLOWED_HOSTS is required in hosted mode');
  });
  it('rejects an unknown mode', () => {
    expect(() => loadHubConfig({ AGENTTEAMS_MODE: 'weird' }, '/h')).toThrow(/AGENTTEAMS_MODE/);
  });
  it('parses and trims allowed hosts, database url, host and port', () => {
    const cfg = loadHubConfig({
      AGENTTEAMS_MODE: 'hosted', AGENTTEAMS_ALLOWED_HOSTS: ' a.example.com , b.example.com,, ',
      DATABASE_URL: 'postgres://x', AGENTTEAMS_HOST: '0.0.0.0', AGENTTEAMS_PORT: '8080',
    }, '/h');
    expect(cfg).toMatchObject({
      mode: 'hosted', host: '0.0.0.0', port: 8080, databaseUrl: 'postgres://x',
      allowedHosts: ['a.example.com', 'b.example.com'],
    });
  });
});
