import { describe, expect, it } from 'vitest';
import { githubVerifier } from '../src/github.js';

const TOKEN = 'gho_secretTokenValue123';

function fakeFetch(res: { status: number; body?: unknown } | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (res instanceof Error) throw res;
    return new Response(JSON.stringify(res.body ?? {}), { status: res.status });
  }) as typeof fetch;
  return { fn, calls };
}

describe('githubVerifier', () => {
  it('returns the user and sends exactly the four headers to GET /user', async () => {
    const f = fakeFetch({ status: 200, body: { login: 'Octocat', id: 583231, extra: 'x' } });
    await expect(githubVerifier(f.fn)(TOKEN)).resolves.toEqual({ login: 'Octocat', id: 583231 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://api.github.com/user');
    expect(f.calls[0]!.init.method ?? 'GET').toBe('GET');
    expect(f.calls[0]!.init.headers).toEqual({
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agentteams-hub',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(f.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([401, 403])('maps %i to "GitHub token rejected"', async (status) => {
    const f = fakeFetch({ status });
    await expect(githubVerifier(f.fn)(TOKEN)).rejects.toMatchObject({ code: 'unauthorized', message: 'GitHub token rejected' });
  });

  it('maps a timeout to "could not verify GitHub identity"', async () => {
    const f = fakeFetch(Object.assign(new Error(`aborted ${TOKEN}`), { name: 'TimeoutError' }));
    await expect(githubVerifier(f.fn)(TOKEN)).rejects.toMatchObject({
      code: 'unauthorized', message: 'could not verify GitHub identity',
    });
  });

  it.each([500, 404])('maps status %i to "could not verify"', async (status) => {
    const f = fakeFetch({ status });
    await expect(githubVerifier(f.fn)(TOKEN)).rejects.toMatchObject({ message: 'could not verify GitHub identity' });
  });

  it('rejects a malformed 200 body as "could not verify"', async () => {
    const f = fakeFetch({ status: 200, body: { login: 5 } });
    await expect(githubVerifier(f.fn)(TOKEN)).rejects.toMatchObject({ message: 'could not verify GitHub identity' });
  });

  it('never puts the token in a thrown message', async () => {
    for (const res of [{ status: 401 }, { status: 500 }, new Error(`boom ${TOKEN}`)]) {
      const err = await githubVerifier(fakeFetch(res).fn)(TOKEN).catch((e: Error) => e);
      expect(String((err as Error).message)).not.toContain(TOKEN);
    }
  });
});
