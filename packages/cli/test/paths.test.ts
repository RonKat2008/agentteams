import { describe, expect, it } from 'vitest';
import { DEFAULT_HUB_URL, LOCAL_HUB_URL, OFFICIAL_HUB_ORIGIN, ephemeralInstallReason, hubLabel, hubUrlFrom } from '../src/paths.js';

describe('hubUrlFrom', () => {
  it('defaults to the public hub', () => {
    expect(DEFAULT_HUB_URL).toBe('https://agentteams-two.vercel.app');
    expect(hubUrlFrom(undefined, {})).toBe(DEFAULT_HUB_URL);
  });
  it('maps "local" (flag or env) to the local hub', () => {
    expect(LOCAL_HUB_URL).toBe('http://127.0.0.1:4747');
    expect(hubUrlFrom('local', {})).toBe(LOCAL_HUB_URL);
    expect(hubUrlFrom(undefined, { AGENTTEAMS_HUB: 'local' })).toBe(LOCAL_HUB_URL);
    expect(hubUrlFrom(' LOCAL ', {})).toBe(LOCAL_HUB_URL);
  });
  it('flag beats env, and explicit urls pass through without trailing slashes', () => {
    expect(hubUrlFrom('http://127.0.0.1:5000/', { AGENTTEAMS_HUB: 'local' })).toBe('http://127.0.0.1:5000');
    expect(hubUrlFrom(undefined, { AGENTTEAMS_HUB: 'https://x.trycloudflare.com/' })).toBe('https://x.trycloudflare.com');
  });
  it('treats an empty env value as unset', () => {
    expect(hubUrlFrom(undefined, { AGENTTEAMS_HUB: '' })).toBe(DEFAULT_HUB_URL);
  });
});

describe('ephemeralInstallReason', () => {
  it.each([
    '/Users/x/.npm/_npx/abc123/node_modules/agentteams/dist/bin.js',
    'C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\agentteams\\dist\\bin.js',
    '/Users/x/Library/Caches/pnpm/dlx-1234/node_modules/agentteams/dist/bin.js',
    '/tmp/bunx-501-agentteams@latest/node_modules/agentteams/dist/bin.js',
  ])('flags %s', (p) => {
    expect(ephemeralInstallReason(p, {})).not.toBeNull();
  });
  it('flags a path under npm_config_cache/_npx', () => {
    expect(ephemeralInstallReason('/c/cache/_npx/k/bin.js', { npm_config_cache: '/c/cache/' })).not.toBeNull();
  });
  it('accepts durable installs', () => {
    expect(ephemeralInstallReason('/usr/local/lib/node_modules/agentteams/dist/bin.js', {})).toBeNull();
    expect(ephemeralInstallReason('/Users/x/.nvm/versions/node/v22/lib/node_modules/agentteams/dist/bin.js', {})).toBeNull();
  });
});

describe('hub identity', () => {
  it('exposes the official origin and labels hubs', () => {
    expect(OFFICIAL_HUB_ORIGIN).toBe('https://agentteams-two.vercel.app');
    expect(hubLabel(DEFAULT_HUB_URL)).toBe(`${DEFAULT_HUB_URL} (public)`);
    expect(hubLabel(LOCAL_HUB_URL)).toBe(`${LOCAL_HUB_URL} (local)`);
    expect(hubLabel('https://x.trycloudflare.com')).toBe('https://x.trycloudflare.com (x.trycloudflare.com)');
  });
});
