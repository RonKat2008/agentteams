/**
 * `agentteams watch`: a live, full-screen dashboard of the team (agents, tasks, activity) for a split pane next
 * to your agent. Without a terminal (piped, CI) or with --once it prints one snapshot and exits.
 */
import type { ToolKind } from '@agentteams/shared';
import { makePalette } from '../color.js';
import type { CliDeps } from '../deps.js';
import { formatEvent, oneLine } from '../format.js';
import { lastSyncedText } from '../git/syncState.js';
import { formatStatusTable } from '../statusTable.js';
import { snapshotSource } from '../watch/data.js';
import { runWatchLoop, type Screen } from '../watch/loop.js';
import { initialState, liveTasks, taskCounts, transportLabel, type Snapshot } from '../watch/model.js';
import { TASK_GLYPHS } from '../watch/panels.js';
import { readableTeams, type TeamAccess } from './shared.js';

export const DEFAULT_WATCH_INTERVAL_SEC = 2;
const SNAPSHOT_EVENTS = 15;
const SNAPSHOT_TASKS = 15;

export interface WatchOpts { agent?: ToolKind; team?: string; interval?: number; once?: boolean }
/** Test seams: a fake screen instead of the real terminal, and a stop signal. */
export interface WatchIo { screen?: Screen; signal?: AbortSignal }

const quote = (s: string) => `"${oneLine(s)}"`;

/** The team to show and, when the repo is in several, a hint naming how to pick the others. */
export function pickTeam(teams: TeamAccess[], name?: string): { access: TeamAccess; note?: string } {
  if (name !== undefined) {
    const hit = teams.find((t) => t.cred.teamName === name);
    if (!hit) throw new Error(`no team ${quote(name)} in this repo; teams here: ${teams.map((t) => quote(t.cred.teamName)).join(', ')}`);
    return { access: hit };
  }
  const access = teams[0]!;
  if (teams.length === 1) return { access };
  const others = teams.slice(1).map((t) => `--team ${oneLine(t.cred.teamName)}`).join(', ');
  return { access, note: `This repo is in ${teams.length} teams; showing ${quote(access.cred.teamName)}. Others: ${others}` };
}

function printSnapshot(deps: CliDeps, access: TeamAccess, snap: Snapshot): void {
  const p = makePalette(deps.color);
  for (const line of formatStatusTable(snap.status, access.mine, p)) deps.out(line);
  const c = taskCounts(snap.tasks);
  deps.out('');
  deps.out(`Tasks: open ${c.open} · in progress ${c.inProgress} · done ${c.done} · merged ${c.merged}`);
  const live = liveTasks(snap.tasks);
  for (const t of live.slice(0, SNAPSHOT_TASKS)) {
    const label = t.status === 'blocked' ? ' (blocked)' : '';
    deps.out(`  ${TASK_GLYPHS[t.status] ?? '○'} #${t.number} ${oneLine(t.title)}${label}  ${t.assignee ? oneLine(t.assignee) : 'unassigned'}`);
  }
  if (live.length > SNAPSHOT_TASKS) deps.out(`  +${live.length - SNAPSHOT_TASKS} more`);
  if (snap.sync) {
    const err = snap.sync.lastError ? ` (last sync failed: ${oneLine(snap.sync.lastError)})` : '';
    deps.out(`Sync: ${lastSyncedText(snap.sync)}${err}`);
  }
  deps.out('');
  deps.out('Recent activity:');
  const recent = snap.events.slice(-SNAPSHOT_EVENTS);
  if (recent.length === 0) deps.out('  (none yet)');
  for (const e of recent) deps.out(formatEvent(e, p));
}

async function live(deps: CliDeps, access: TeamAccess, note: string | undefined, opts: WatchOpts, io: WatchIo): Promise<void> {
  const { processScreen, installRestoreGuards } = await import('../watch/terminal.js');
  const screen = io.screen ?? processScreen();
  const ac = new AbortController();
  const stopOuter = () => ac.abort();
  io.signal?.addEventListener('abort', stopOuter, { once: true });
  const removeGuards = io.screen ? () => {} : installRestoreGuards(screen, stopOuter);
  try {
    await runWatchLoop({
      screen, fetch: snapshotSource(deps, access.cred), color: deps.color, signal: ac.signal,
      state: initialState(transportLabel(access.cred), access.mine, note),
      intervalMs: Math.max(1, opts.interval ?? DEFAULT_WATCH_INTERVAL_SEC) * 1000,
    });
  } finally {
    removeGuards();
    io.signal?.removeEventListener('abort', stopOuter);
  }
}

export async function watchCommand(deps: CliDeps, opts: WatchOpts, io: WatchIo = {}): Promise<void> {
  const { access, note } = pickTeam(await readableTeams(deps, opts.agent), opts.team);
  if (opts.once || !deps.isTTY) {
    if (note) deps.err(`agentteams: ${note}`);
    printSnapshot(deps, access, await snapshotSource(deps, access.cred)());
    return;
  }
  await live(deps, access, note, opts, io);
}
