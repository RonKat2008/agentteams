import type { ToolKind } from '@agentteams/shared';
import { makePalette } from '../color.js';
import type { CliDeps } from '../deps.js';
import { formatEvent, oneLine } from '../format.js';
import { syncSummaryLine } from '../git/syncState.js';
import { clientFor, readableTeams } from './shared.js';

const DEFAULT_INTERVAL_MS = 2000;
const FOLLOW_BATCH = 100;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', done); resolve(); }, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

export interface LogOpts { agent?: ToolKind; follow: boolean; limit: number; intervalMs?: number; signal?: AbortSignal }

export async function logCommand(deps: CliDeps, opts: LogOpts): Promise<void> {
  const teams = await readableTeams(deps, opts.agent);
  const { cred } = teams[0]!;
  if (teams.length > 1) {
    const names = teams.slice(1).map((t) => `"${oneLine(t.cred.teamName)}" (--agent ${t.cred.tool})`).join(', ');
    deps.err(`agentteams: this repo is in ${teams.length} teams; showing "${oneLine(cred.teamName)}". For the others pass --agent: ${names}`);
  }
  const client = clientFor(deps, cred);
  const palette = makePalette(deps.color);
  const first = await client.activity({ limit: opts.limit });
  for (const e of first) deps.out(formatEvent(e, palette));
  if (cred.transport === 'git') deps.out(`(${await syncSummaryLine(deps, cred.repoPath)})`);
  if (!opts.follow) return;
  let last = first.reduce<string | undefined>((m, e) => (m === undefined || e.createdAt > m ? e.createdAt : m), undefined);
  while (!opts.signal?.aborted) {
    await sleep(opts.intervalMs ?? DEFAULT_INTERVAL_MS, opts.signal);
    if (opts.signal?.aborted) break;
    const events = await client.activity({ since: last, limit: FOLLOW_BATCH });
    for (const e of events) {
      deps.out(formatEvent(e, palette));
      if (last === undefined || e.createdAt > last) last = e.createdAt;
    }
  }
}
