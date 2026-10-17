/** The watch dashboard's state and the pure facts derived from it (counts, ages, labels). */
import type { ActivityEvent, AgentView, TaskView, TeamStatus } from '@agentteams/shared';
import type { Credential } from '../credentials.js';
import { oneLine } from '../format.js';
import { stripCredentials } from '../git/remoteUrl.js';

/** One poll's worth of team data. */
export interface Snapshot {
  status: TeamStatus;
  tasks: TaskView[];
  /** Oldest first, as the activity API returns them. */
  events: ActivityEvent[];
  /** git teams: the background sync's bookkeeping. */
  sync?: { lastFetchAt?: string; lastError?: string | null };
}

export interface WatchState {
  /** "this computer", "shared via <remote>" or "hub <host>". */
  transport: string;
  /** The repo's own agents on this team, marked "you". */
  mine: readonly string[];
  /** Set when this repo is in more than one team: how to pick another. */
  note?: string;
  snapshot?: Snapshot;
  /** When the snapshot was fetched (ms). */
  updatedAt?: number;
  /** The last poll's error; cleared by the next good poll. */
  error?: string;
  /** When the next poll after an error is due (ms). */
  retryAt?: number;
  onlyActive: boolean;
  /** Feed lines scrolled away from the newest. */
  scroll: number;
  help: boolean;
}

export const initialState = (transport: string, mine: readonly string[], note?: string): WatchState => ({
  transport, mine, ...(note === undefined ? {} : { note }), onlyActive: false, scroll: 0, help: false,
});

export interface TaskCounts { open: number; inProgress: number; done: number; merged: number }

/** open counts every task not started yet (open, assigned, blocked); done excludes merged ones. */
export function taskCounts(tasks: readonly TaskView[]): TaskCounts {
  const c: TaskCounts = { open: 0, inProgress: 0, done: 0, merged: 0 };
  for (const t of tasks) {
    if (t.status === 'in_progress') c.inProgress++;
    else if (t.status === 'done') { if (t.mergedAt) c.merged++; else c.done++; }
    else c.open++;
  }
  return c;
}

const STATUS_ORDER: Record<string, number> = { in_progress: 0, blocked: 1, assigned: 2, open: 3 };

/** In-progress tasks first, then blocked, then waiting ones; by number within each group. */
export function liveTasks(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter((t) => t.status !== 'done')
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.number - b.number);
}

const parseMs = (iso: string | null | undefined): number | undefined => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? undefined : ms;
};

/** The agent's newest event in the feed, else when it was last seen (ms), else undefined. */
export function lastActivityAt(agent: AgentView, events: readonly ActivityEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.agent === agent.name) {
      const ms = parseMs(events[i]!.createdAt);
      if (ms !== undefined) return ms;
    }
  }
  return parseMs(agent.lastSeenAt);
}

/** "now", "12s", "4m", "2h", "3d"; "—" when unknown. */
export function ago(at: number | undefined, now: number): string {
  if (at === undefined) return '—';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 2) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export const isWorking = (a: AgentView): boolean => a.presence === 'active' && a.currentTask?.status === 'in_progress';

/** Agents shown: all, or only active ones when toggled. */
export const visibleAgents = (state: WatchState): AgentView[] =>
  (state.snapshot?.status.agents ?? []).filter((a) => !state.onlyActive || a.presence === 'active');

/** How the team is reached, for the header. Never includes keys or URL credentials. */
export function transportLabel(cred: Credential): string {
  if (cred.transport === 'local') return 'this computer';
  if (cred.transport === 'git') return `shared via ${oneLine(stripCredentials(cred.git?.remote ?? 'git'))}`;
  try {
    return `hub ${new URL(cred.hubUrl).host}`;
  } catch {
    return `hub ${oneLine(stripCredentials(cred.hubUrl))}`;
  }
}

export const messageOf = (e: unknown): string => oneLine(e instanceof Error ? e.message : String(e));
