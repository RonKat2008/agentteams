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
      allowedHosts: ['127.0.0.1', 'localhost'], ipSource: 'socket',
      rateLimits: { agentPerMin: 300, ipPerMin: 10 },
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

describe('trusted client-IP source', () => {
  const hosted = { AGENTTEAMS_MODE: 'hosted', AGENTTEAMS_ALLOWED_HOSTS: 'h.example.com' };
  it('is the socket by default, in hosted and local mode', () => {
    expect(loadHubConfig(hosted, '/h').ipSource).toBe('socket');
    expect(loadHubConfig({}, '/h').ipSource).toBe('socket');
  });
  it('VERCEL=1 selects vercel, taking precedence over Fly and a custom header', () => {
    expect(loadHubConfig({ ...hosted, VERCEL: '1', FLY_APP_NAME: 'a', AGENTTEAMS_TRUSTED_IP_HEADER: 'x-ip' }, '/h').ipSource).toBe('vercel');
  });
  it('FLY_APP_NAME selects fly, taking precedence over a custom header', () => {
    expect(loadHubConfig({ ...hosted, FLY_APP_NAME: 'a', AGENTTEAMS_TRUSTED_IP_HEADER: 'x-ip' }, '/h').ipSource).toBe('fly');
  });
  it('AGENTTEAMS_TRUSTED_IP_HEADER selects that header', () => {
    expect(loadHubConfig({ ...hosted, AGENTTEAMS_TRUSTED_IP_HEADER: 'cf-connecting-ip' }, '/h').ipSource).toEqual({ header: 'cf-connecting-ip' });
  });
  it('refuses x-forwarded-for unless AGENTTEAMS_TRUSTED_PROXY_APPENDS=1', () => {
    const msg = 'AGENTTEAMS_TRUSTED_IP_HEADER=x-forwarded-for needs AGENTTEAMS_TRUSTED_PROXY_APPENDS=1 (the hub uses the last entry); prefer a header your proxy overwrites, such as x-real-ip';
    expect(() => loadHubConfig({ ...hosted, AGENTTEAMS_TRUSTED_IP_HEADER: 'x-forwarded-for' }, '/h')).toThrow(msg);
    expect(loadHubConfig({ ...hosted, AGENTTEAMS_TRUSTED_IP_HEADER: 'x-forwarded-for', AGENTTEAMS_TRUSTED_PROXY_APPENDS: '1' }, '/h').ipSource).toEqual({ header: 'x-forwarded-for' });
  });
  it('rejects a malformed header name', () => {
    expect(() => loadHubConfig({ ...hosted, AGENTTEAMS_TRUSTED_IP_HEADER: 'X IP' }, '/h')).toThrow(/AGENTTEAMS_TRUSTED_IP_HEADER/);
  });
  it('local mode ignores platform env', () => {
    expect(loadHubConfig({ VERCEL: '1', FLY_APP_NAME: 'a' }, '/h').ipSource).toBe('socket');
  });
});

describe('rate limit settings', () => {
  it('reads AGENTTEAMS_AGENT_RATE_PER_MIN and AGENTTEAMS_IP_RATE_PER_MIN', () => {
    expect(loadHubConfig({ AGENTTEAMS_AGENT_RATE_PER_MIN: '500', AGENTTEAMS_IP_RATE_PER_MIN: '20' }, '/h').rateLimits)
      .toEqual({ agentPerMin: 500, ipPerMin: 20 });
  });
  it.each(['0', '-5', '1.5', 'abc', ' ', '1e3'])('rejects %j', (bad) => {
    expect(() => loadHubConfig({ AGENTTEAMS_AGENT_RATE_PER_MIN: bad }, '/h')).toThrow(/AGENTTEAMS_AGENT_RATE_PER_MIN must be a positive integer/);
    expect(() => loadHubConfig({ AGENTTEAMS_IP_RATE_PER_MIN: bad }, '/h')).toThrow(/AGENTTEAMS_IP_RATE_PER_MIN must be a positive integer/);
  });
});
