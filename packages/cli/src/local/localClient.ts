import type {
  ActivityEvent, CheckFilesResult, CommitInput, InboxMessage, TaskView, TeamStatus,
} from '@agentteams/shared';
import type { CliDeps } from '../deps.js';
import type { Credential } from '../credentials.js';
import { HubError } from '../hubClient.js';
import type { TeamClient } from '../teamClient.js';
import { openTeamStore, type TeamStore } from './store.js';

const STATUS: Record<string, number> = {
  unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, invalid: 400, rate_limited: 429,
};

const isBusy = (e: unknown): boolean => /^SQLITE_BUSY|database is locked/.test(`${(e as { code?: string })?.code ?? ''} ${(e as Error)?.message ?? ''}`);

/** Same rule as the HTTP route: a positive safe integer. */
export function taskNumber(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new HubError('invalid', 'task number must be a positive integer', 400);
  return n;
}

/** HTTP responses are JSON; round-trip so callers see exactly the shapes HubClient returns. */
export const wire = <T>(v: unknown): T => JSON.parse(JSON.stringify(v ?? null)) as T;

/** Maps a service error to the HubError an HTTP client would see (DomainError code, busy -> conflict, else internal). */
export function toHubError(core: TeamStore['core'], err: unknown): HubError {
  if (err instanceof HubError) return err;
  if (err instanceof core.DomainError) return new HubError(err.code, err.message, STATUS[err.code] ?? 500);
  if (isBusy(err)) return new HubError('conflict', 'the team database is busy (another agent is writing); retry in a moment', 409);
  return new HubError('internal', 'internal error', 500);
}

/** HTTP-like status for a hub error code. */
export const statusOf = (code: string): number => STATUS[code] ?? 500;

/** TeamClient backed by the repo's SQLite database in-process: no server, no network. */
export class LocalTeamClient implements TeamClient {
  constructor(private readonly deps: Pick<CliDeps, 'exec'>, private readonly cred: Credential) {}

  private async run<T>(fn: (s: TeamStore, actor: Awaited<ReturnType<TeamStore['core']['authenticate']>>) => Promise<unknown>): Promise<T> {
    const store = await openTeamStore(this.deps, this.cred.repoPath);
    try {
      const actor = await store.core.authenticate(store.ctx, this.cred.apiKey);
      return wire<T>(await fn(store, actor));
    } catch (err) {
      throw toHubError(store.core, err);
    }
  }

  ping(markRead = true, limit?: number) {
    return this.run<{ agent: string; messages: InboxMessage[] }>(async (s, a) => ({
      agent: a.name,
      messages: await s.core.readInbox(s.ctx, a, { markRead, ...(limit === undefined ? {} : { limit }) } as never),
    }));
  }
  status() {
    return this.run<TeamStatus>((s, a) => s.core.getTeamStatus(s.ctx, a));
  }
  activity(q: { since?: string; limit?: number } = {}) {
    // The HTTP route hands the service string query params; do the same.
    const query: Record<string, string> = {};
    if (q.since !== undefined) query.since = q.since;
    if (q.limit !== undefined) query.limit = String(q.limit);
    return this.run<ActivityEvent[]>((s, a) => s.core.getActivity(s.ctx, a, query));
  }
  setOrchestrator(agent: string) {
    return this.run<{ orchestrator: string }>((s, a) => s.core.setOrchestrator(s.ctx, a, { agent }));
  }
  rotateInvite() {
    return this.run<{ inviteCode: string; inviteExpiresAt: string }>((s, a) => s.core.rotateInvite(s.ctx, a));
  }
  revokeInvite() {
    return this.run<{ revoked: true }>((s, a) => s.core.revokeInvite(s.ctx, a));
  }
  checkFiles(paths: string[]) {
    return this.run<CheckFilesResult>((s, a) => s.core.checkFiles(s.ctx, a, { paths } as never));
  }
  claimOverride(paths: string[], sha?: string) {
    return this.run<{ owners: string[] }>((s, a) => s.core.recordClaimOverride(s.ctx, a, { paths, ...(sha === undefined ? {} : { sha }) } as never));
  }
  async claimTask(n: number) {
    taskNumber(n);
    return this.run<TaskView>((s, a) => s.core.claimTask(s.ctx, a, { task: n }));
  }
  async completeTask(n: number, summary: string, branch: string) {
    taskNumber(n);
    return this.run<TaskView>((s, a) => s.core.completeTask(s.ctx, a, { task: n, summary, branch } as never));
  }
  async markMerged(n: number, pr?: string) {
    taskNumber(n);
    return this.run<TaskView>((s, a) => s.core.markMerged(s.ctx, a, { task: n, ...(pr === undefined ? {} : { pr }) } as never));
  }
  async getTask(n: number) {
    taskNumber(n);
    return this.run<TaskView>((s, a) => s.core.getTaskView(s.ctx, a, n));
  }
  recordCommit(input: CommitInput) {
    return this.run<{ notified: string[]; duplicate: boolean }>((s, a) => s.core.recordCommit(s.ctx, a, input as never));
  }
}
