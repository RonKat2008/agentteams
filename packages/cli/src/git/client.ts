/**
 * TeamClient for git teams. Reads are served from the local view (team.db); writes become ops (view.ts:
 * capture, validate, persist as pending, apply locally) and then start a detached sync that pushes them.
 * Reads start a detached sync when the last fetch is older than 10 s. Nothing here waits on the network.
 *
 * Kept light for hooks: only node built-ins and syncState load statically; the op machinery (zod schemas,
 * replay, SQLite) loads on first use.
 */
import type {
  ActivityEvent, CheckFilesResult, CommitInput, InboxMessage, ReadInboxInput, TaskView, TeamStatus,
} from '@agentteams/shared';
import type { Actor } from '@agentteams/hub/core';
import type { CliDeps } from '../deps.js';
import type { Credential } from '../credentials.js';
import { HubError } from '../hubClient.js';
import { taskNumber, toHubError, wire } from '../local/localClient.js';
import type { TeamClient } from '../teamClient.js';
import { shouldSyncForRead, spawnDetachedSync, type SyncTrigger } from './syncState.js';
import type { OpInput, RegularOpName } from './ops.js';
import type { GitView } from './view.js';

type Deps = Pick<CliDeps, 'exec'>;
type ViewModule = typeof import('./view.js');

const INBOX_PAGE = 100;
const NOTICE_SENDER = 'agentteams';

export const GIT_INVITE_REFUSAL =
  'git teams have no invite to rotate or revoke: access is controlled by the team repo (remove a collaborator there), ' +
  'and a new invite would need a new team key, which is not supported';

export interface GitClientOptions {
  /** Starts a background sync. Default: spawn `agentteams sync` detached. */
  trigger?: SyncTrigger;
  now?: () => number;
}

export class GitTeamClient implements TeamClient {
  private readonly now: () => number;
  private readonly trigger: SyncTrigger;

  constructor(private readonly deps: Deps, private readonly cred: Credential, opts: GitClientOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.trigger = opts.trigger ?? (() => spawnDetachedSync(cred.repoPath, cred.tool));
  }

  private async open(): Promise<{ mod: ViewModule; view: GitView }> {
    const mod = await import('./view.js');
    return { mod, view: await mod.openGitView(this.deps, this.cred) };
  }

  /** Runs a read against the view as this agent; records presence locally; maybe starts a background fetch. */
  private async read<T>(fn: (view: GitView, actor: Actor, mod: ViewModule) => Promise<unknown>): Promise<T> {
    const { mod, view } = await this.open();
    try {
      const actor = await mod.requireActor(view);
      await mod.heartbeat(view.store, actor.id, this.now());
      return wire<T>(await fn(view, actor, mod));
    } catch (err) {
      throw toHubError(view.store.core, err);
    } finally {
      await this.maybeSyncForRead();
    }
  }

  private async maybeSyncForRead(): Promise<void> {
    try {
      if (await shouldSyncForRead(this.deps, this.cred.repoPath, this.now())) this.trigger();
    } catch { /* never fail a read over the background sync */ }
  }

  /** Per MCP tool call: presence for this agent and, if the view is stale, a background fetch. */
  async touch(): Promise<void> {
    try {
      const { mod, view } = await this.open();
      await mod.heartbeat(view.store, view.git.agentId, this.now());
    } catch { /* presence is best effort */ }
    await this.maybeSyncForRead();
  }

  /** One state-changing call as an op. Returns the service response (JSON shape, as over HTTP). */
  async execute<N extends RegularOpName>(name: N, input: OpInput<N>): Promise<unknown> {
    const { mod, view } = await this.open();
    let logged = false;
    try {
      const { result, op } = await mod.executeOp(view, name, input, this.now);
      logged = op !== null;
      // The write is applied and queued: a presence hiccup (e.g. SQLITE_BUSY) must not turn it into an error.
      await mod.heartbeat(view.store, view.git.agentId, this.now()).catch(() => undefined);
      return wire(result);
    } catch (err) {
      throw toHubError(view.store.core, err);
    } finally {
      if (logged) this.trigger();
      else await this.maybeSyncForRead();
    }
  }

  /**
   * Unread messages (and local rejection notices first) without side effects in the view; when `markRead`,
   * the returned messages are marked read through a `markRead` op and the notices are marked delivered.
   */
  async inbox(input: ReadInboxInput = {}): Promise<{ agent: string; messages: InboxMessage[] }> {
    const markRead = input.markRead ?? true;
    const limit = Math.min(input.limit ?? INBOX_PAGE, INBOX_PAGE);
    const peek = await this.read<{ agent: string; messages: InboxMessage[]; notices: string[] }>(async (view, actor) => {
      const notices = await view.store.ctx.db.selectFrom('replica_notices').select(['op_id', 'body', 'created_at'])
        .where('agent_id', '=', actor.id).where('delivered_at', 'is', null).orderBy('op_id').limit(limit).execute();
      const fromNotices: InboxMessage[] = notices.map((n) => ({
        id: n.op_id, from: NOTICE_SENDER, fromRole: 'peer', to: actor.name, kind: 'fyi', body: n.body, createdAt: n.created_at,
      }));
      const room = limit - fromNotices.length;
      const messages = room > 0 ? await view.store.core.readInbox(view.store.ctx, actor, { markRead: false, limit: room }) : [];
      return { agent: actor.name, messages: [...fromNotices, ...messages], notices: notices.map((n) => n.op_id) };
    });
    if (markRead) {
      const ids = peek.messages.filter((m) => !peek.notices.includes(m.id)).map((m) => m.id);
      if (ids.length > 0) await this.execute('markRead', { messageIds: ids });
      if (peek.notices.length > 0) {
        await this.read(async (view) => view.store.ctx.db.updateTable('replica_notices').set({ delivered_at: new Date(this.now()).toISOString() })
          .where('op_id', 'in', peek.notices).execute());
      }
    }
    return { agent: peek.agent, messages: peek.messages };
  }

  ping(markRead = true, limit?: number) {
    return this.inbox({ markRead, ...(limit === undefined ? {} : { limit }) });
  }
  status() {
    return this.read<TeamStatus>((v, a) => v.store.core.getTeamStatus(v.store.ctx, a));
  }
  activity(q: { since?: string; limit?: number } = {}) {
    const query: Record<string, string> = {};
    if (q.since !== undefined) query.since = q.since;
    if (q.limit !== undefined) query.limit = String(q.limit);
    return this.read<ActivityEvent[]>((v, a) => v.store.core.getActivity(v.store.ctx, a, query));
  }
  async setOrchestrator(agent: string) {
    return (await this.execute('setOrchestrator', { agent })) as { orchestrator: string };
  }
  async rotateInvite(): Promise<{ inviteCode: string; inviteExpiresAt: string }> {
    throw new HubError('invalid', GIT_INVITE_REFUSAL, 400);
  }
  async revokeInvite(): Promise<{ revoked: true }> {
    throw new HubError('invalid', GIT_INVITE_REFUSAL, 400);
  }
  checkFiles(paths: string[]) {
    return this.read<CheckFilesResult>((v, a) => v.store.core.checkFiles(v.store.ctx, a, { paths } as never));
  }
  async claimOverride(paths: string[], sha?: string) {
    return (await this.execute('recordClaimOverride', { paths, ...(sha === undefined ? {} : { sha }) })) as { owners: string[] };
  }
  async claimTask(n: number) {
    return (await this.execute('claimTask', { task: taskNumber(n) })) as TaskView;
  }
  async completeTask(n: number, summary: string, branch: string) {
    return (await this.execute('completeTask', { task: taskNumber(n), summary, branch })) as TaskView;
  }
  async markMerged(n: number, pr?: string) {
    return (await this.execute('markMerged', { task: taskNumber(n), ...(pr === undefined ? {} : { pr }) })) as TaskView;
  }
  async getTask(n: number) {
    taskNumber(n);
    return this.read<TaskView>((v, a) => v.store.core.getTaskView(v.store.ctx, a, n));
  }
  async recordCommit(input: CommitInput) {
    return (await this.execute('recordCommit', input as OpInput<'recordCommit'>)) as { notified: string[]; duplicate: boolean };
  }
}
