import type {
  ActivityEvent, CheckFilesResult, CommitInput, InboxMessage, TaskView, TeamStatus,
} from '@agentteams/shared';
import type { Credential } from './credentials.js';
import type { CliDeps } from './deps.js';
import { HubClient } from './hubClient.js';
import { LocalTeamClient } from './local/localClient.js';

/** The authenticated, per-agent operations every transport (http, local, git) must provide. */
export interface TeamClient {
  ping(markRead?: boolean, limit?: number): Promise<{ agent: string; messages: InboxMessage[] }>;
  status(): Promise<TeamStatus>;
  activity(q?: { since?: string; limit?: number }): Promise<ActivityEvent[]>;
  setOrchestrator(agent: string): Promise<{ orchestrator: string }>;
  rotateInvite(): Promise<{ inviteCode: string; inviteExpiresAt: string }>;
  revokeInvite(): Promise<{ revoked: true }>;
  checkFiles(paths: string[]): Promise<CheckFilesResult>;
  claimOverride(paths: string[], sha?: string): Promise<{ owners: string[] }>;
  claimTask(n: number): Promise<TaskView>;
  completeTask(n: number, summary: string, branch: string): Promise<TaskView>;
  markMerged(n: number, pr?: string): Promise<TaskView>;
  getTask(n: number): Promise<TaskView>;
  recordCommit(input: CommitInput): Promise<{ notified: string[]; duplicate: boolean }>;
}

export interface TeamClientOptions { timeoutMs?: number }

/** Build the client for a credential's transport (http when unset). */
export function teamClientFor(deps: Pick<CliDeps, 'fetch' | 'exec'>, cred: Credential, opts: TeamClientOptions = {}): TeamClient {
  const transport = cred.transport ?? 'http';
  if (transport === 'local') return new LocalTeamClient(deps, cred);
  if (transport !== 'http') throw new Error('transport not supported yet');
  return new HubClient(cred.hubUrl, { apiKey: cred.apiKey, fetch: deps.fetch, ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) });
}
