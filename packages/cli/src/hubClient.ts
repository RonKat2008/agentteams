import type {
  ActivityEvent, CreateTeamInput, InboxMessage, JoinTeamInput, RepoLink, TeamStatus,
} from '@agentteams/shared';

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

export class HubClient {
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
      });
      text = await res.text();
    } catch {
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
}
