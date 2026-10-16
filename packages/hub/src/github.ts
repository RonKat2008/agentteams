import { DomainError } from './errors.js';

export interface GithubUser { login: string; id: number }
/** Throws DomainError('unauthorized') when the token is rejected or identity cannot be verified. */
export type GithubVerifier = (token: string) => Promise<GithubUser>;

const GITHUB_USER_URL = 'https://api.github.com/user';
const VERIFY_TIMEOUT_MS = 5000;

const rejected = () => new DomainError('unauthorized', 'GitHub token rejected');
const unverifiable = () => new DomainError('unauthorized', 'could not verify GitHub identity');

/**
 * Verifies a token with exactly one GET /user call. The token is used only for that request's
 * Authorization header and never appears in thrown errors.
 */
export function githubVerifier(fetchFn: typeof fetch = fetch): GithubVerifier {
  return async (token) => {
    let res: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      res = await fetchFn(GITHUB_USER_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'agentteams-hub',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
    } catch {
      throw unverifiable();
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw rejected();
    if (res.status !== 200) throw unverifiable();
    const body = (await res.json().catch(() => null)) as { login?: unknown; id?: unknown } | null;
    if (!body || typeof body.login !== 'string' || body.login === '' || typeof body.id !== 'number') throw unverifiable();
    return { login: body.login, id: body.id };
  };
}
