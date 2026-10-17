/**
 * One dashboard poll: team status, the task board and recent activity through the credential's TeamClient,
 * plus the background sync's bookkeeping for git teams. local and git reads are local database reads (a git
 * read starts a detached sync when the view is stale); only http goes over the network.
 */
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import { readStatus, syncPaths } from '../git/syncState.js';
import { teamClientFor } from '../teamClient.js';
import type { Snapshot } from './model.js';

/** Events kept in the feed (the activity API's maximum page is 500). */
export const FEED_EVENTS = 200;
/** A hung hub request fails the poll (shown in the header) instead of freezing the data. */
const HTTP_TIMEOUT_MS = 10_000;

export function snapshotSource(deps: CliDeps, cred: Credential): () => Promise<Snapshot> {
  const client = teamClientFor(deps, cred, { timeoutMs: HTTP_TIMEOUT_MS });
  const http = (cred.transport ?? 'http') === 'http';
  return async () => {
    // Over http the three reads go in parallel; the local database is read one call at a time.
    const [status, tasks, events] = http
      ? await Promise.all([client.status(), client.listTasks(), client.activity({ limit: FEED_EVENTS })])
      : [await client.status(), await client.listTasks(), await client.activity({ limit: FEED_EVENTS })];
    if (cred.transport !== 'git') return { status, tasks, events };
    const s = await readStatus(await syncPaths(deps, cred.repoPath));
    return {
      status, tasks, events,
      sync: { ...(s.lastFetchAt === undefined ? {} : { lastFetchAt: s.lastFetchAt }), lastError: s.lastError ?? null },
    };
  };
}
