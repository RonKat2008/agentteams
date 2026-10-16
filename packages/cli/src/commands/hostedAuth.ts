import type { CliDeps } from '../deps.js';
import { HubClient } from '../hubClient.js';
import { OFFICIAL_HUB_ORIGIN } from '../paths.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function assertSafeTransport(hubUrl: string): void {
  let url: URL;
  try {
    url = new URL(hubUrl);
  } catch {
    throw new Error('invalid hub URL');
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new Error('refusing to send your GitHub token to a non-HTTPS hub');
}

export interface TokenOpts { trustHub?: boolean }

/** Any hub other than the official one must be explicitly trusted before it sees the user's GitHub token. */
async function confirmThirdPartyHub(deps: CliDeps, hubUrl: string, opts: TokenOpts): Promise<void> {
  if (new URL(hubUrl).origin === OFFICIAL_HUB_ORIGIN || opts.trustHub) return;
  const host = new URL(hubUrl).host;
  if (!deps.isTTY) {
    throw new Error(`${host} is not the official agentteams hub and would receive your GitHub token; re-run with --trust-hub if you trust whoever runs it`);
  }
  deps.err(`This sends your GitHub token to ${host}. Only continue if you trust whoever runs it`);
  const answer = (await deps.prompt(`Send your GitHub token to ${host}? [y/N] `)).trim();
  if (!/^y(es)?$/i.test(answer)) throw new Error(`cancelled: GitHub token not sent to ${host}`);
}

/**
 * Asks the hub for its mode; for a hosted hub returns the user's `gh auth token`, otherwise undefined.
 * The token is returned to the caller only: it is never printed, logged or saved.
 */
export async function githubTokenFor(deps: CliDeps, hubUrl: string, opts: TokenOpts = {}): Promise<string | undefined> {
  const { mode } = await new HubClient(hubUrl, { fetch: deps.fetch }).health();
  if (mode !== 'hosted') return undefined;
  assertSafeTransport(hubUrl);
  await confirmThirdPartyHub(deps, hubUrl, opts);
  deps.out(`Verifying your GitHub identity with ${new URL(hubUrl).hostname} (your gh token is sent once and not stored)`);
  const res = await deps.exec('gh', ['auth', 'token']);
  if (res.code === 127) throw new Error('this hub requires GitHub identity: install the GitHub CLI and run gh auth login');
  const token = res.stdout.trim();
  if (res.code !== 0 || !token) throw new Error('gh is not logged in; run: gh auth login');
  return token;
}
