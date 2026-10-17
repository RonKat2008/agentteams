import type {
  ActivityEvent, CheckFilesResult, CommitInput, CreateTeamInput, InboxMessage, InvitePreview, MessageKind, JoinTeamInput, RepoLink, TaskView,
  TeamStatus,
} from '@agentteams/shared';

import type { TeamClient } from './teamClient.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export class HubError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'HubError';
  }
}

export interface HubClientOptions { apiKey?: string; timeoutMs?: number; fetch?: typeof fetch }

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** undici surfaces `redirect: 'error'` as TypeError('fetch failed') with a cause mentioning the redirect. */
function isRedirectError(e: unknown): boolean {
  const cause = (e as { cause?: { message?: unknown } } | undefined)?.cause;
  return /redirect/i.test(`${(e as Error | undefined)?.message ?? ''} ${typeof cause?.message === 'string' ? cause.message : ''}`);
}

export class HubClient implements TeamClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(readonly baseUrl: string, private readonly opts: HubClientOptions = {}) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    let res: Response;
    let text: string;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
      text = await res.text();
    } catch (e) {
      if (isRedirectError(e)) {
        throw new HubError('unreachable', "hub redirected the request; use the hub's final URL with --hub", 0);
      }
      throw new HubError('unreachable', `cannot reach the agentteams hub at ${this.baseUrl} — is it running? (start it with: agentteams up)`, 0);
    }
    const data = parseJson(text);
    if (!res.ok) {
      const e = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new HubError(e?.code ?? 'internal', e?.message ?? `hub returned HTTP ${res.status}`, res.status);
    }
    if (data === undefined) throw new HubError('internal', 'hub returned an invalid response', res.status);
    return data as T;
  }

  private qs(q: Record<string, string | number | undefined>): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  health() {
    return this.request<{ ok: true; mode: 'local' | 'hosted' }>('GET', '/health');
  }
  createTeam(input: CreateTeamInput) {
    return this.request<{ teamId: string; teamName: string; agentName: string; apiKey: string; inviteCode: string; inviteExpiresAt: string }>('POST', '/api/teams', input);
  }
  joinTeam(input: JoinTeamInput) {
    return this.request<{ teamId: string; teamName: string; agentName: string; apiKey: string; repo: RepoLink }>('POST', '/api/join', input);
  }
  ping(markRead = true, limit?: number) {
    return this.request<{ agent: string; messages: InboxMessage[] }>('POST', '/api/team/ping', { markRead, ...(limit === undefined ? {} : { limit }) });
  }
  status() {
    return this.request<TeamStatus>('GET', '/api/team/status');
  }
  activity(q: { since?: string; limit?: number } = {}) {
    return this.request<ActivityEvent[]>('GET', `/api/team/activity${this.qs(q)}`);
  }
  setOrchestrator(agent: string) {
    return this.request<{ orchestrator: string }>('POST', '/api/team/orchestrator', { agent });
  }
  rotateInvite() {
    return this.request<{ inviteCode: string; inviteExpiresAt: string }>('POST', '/api/team/invite/rotate');
  }
  revokeInvite() {
    return this.request<{ revoked: true }>('POST', '/api/team/invite/revoke');
  }
  previewInvite(inviteCode: string) {
    return this.request<InvitePreview>('POST', '/api/join/preview', { inviteCode });
  }
  checkFiles(paths: string[]) {
    return this.request<CheckFilesResult>('POST', '/api/team/check-files', { paths });
  }
  claimOverride(paths: string[], sha?: string) {
    return this.request<{ owners: string[] }>('POST', '/api/team/claim-override', { paths, ...(sha === undefined ? {} : { sha }) });
  }
  claimTask(n: number) {
    return this.request<TaskView>('POST', `/api/team/tasks/${n}/claim`);
  }
  completeTask(n: number, summary: string, branch: string) {
    return this.request<TaskView>('POST', `/api/team/tasks/${n}/complete`, { summary, branch });
  }
  markMerged(n: number, pr?: string) {
    return this.request<TaskView>('POST', `/api/team/tasks/${n}/merged`, pr === undefined ? {} : { pr });
  }
  getTask(n: number) {
    return this.request<TaskView>('GET', `/api/team/tasks/${n}`);
  }
  sendMessage(to: string, body: string, kind: MessageKind = 'fyi') {
    return this.request<{ id: string; to: string }>('POST', '/api/team/messages', { to, body, kind });
  }
  listTasks() {
    return this.request<TaskView[]>('GET', '/api/team/tasks');
  }
  recordCommit(input: CommitInput) {
    return this.request<{ notified: string[]; duplicate: boolean }>('POST', '/api/team/commits', input);
  }
}
