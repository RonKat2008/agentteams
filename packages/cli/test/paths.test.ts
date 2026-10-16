import { describe, expect, it } from 'vitest';
import { DEFAULT_HUB_URL, LOCAL_HUB_URL, hubUrlFrom } from '../src/paths.js';

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
