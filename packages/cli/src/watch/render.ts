/**
 * renderFrame(state, size) → the whole dashboard as `height` lines of exactly `width` cells joined by "\n".
 * Pure: no I/O, the clock comes in as `now`. The loop (loop.ts) positions and writes the lines.
 */
import { makePalette, type Palette } from '../color.js';
import { oneLine } from '../format.js';
import { visibleAgents, liveTasks, type WatchState } from './model.js';
import { agentsPanel, box, clockText, feedLines, feedPanel, tasksPanel, titleLine, type PanelCtx } from './panels.js';
import { fit, padCells, truncate } from './text.js';

export interface RenderOpts { width: number; height: number; color: boolean; now: number }

export const MIN_WIDTH = 50;
export const MIN_HEIGHT = 12;
const WIDE_WIDTH = 110;
const SEPARATOR = ' │ ';

interface Rect { w: number; h: number }
interface Layout { wide: boolean; header: string[]; agents: Rect; tasks: Rect; feed: Rect }

function age(ms: number | undefined, now: number): string {
  if (ms === undefined || Number.isNaN(ms)) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

function headerLine(st: WatchState, o: RenderOpts, p: Palette): string {
  const snap = st.snapshot;
  const parts = [snap ? oneLine(snap.status.team.name) : 'agentteams', truncate(st.transport, Math.max(16, Math.floor(o.width * 0.3)))];
  if (snap?.sync) parts.push(`synced ${age(Date.parse(snap.sync.lastFetchAt ?? ''), o.now)} ago`.replace('synced never ago', 'never synced'));
  if (snap) parts.push(`★ ${oneLine(snap.status.team.orchestrator ?? 'no orchestrator')}`);
  const clock = clockText(o.now);
  const left = truncate(` ${parts.join(' · ')}`, o.width - clock.length - 2);
  const [name = '', ...rest] = left.slice(1).split(' · ');
  const colored = ` ${p.bold(name)}${rest.length ? p.dim(' · ') + rest.join(p.dim(' · ')) : ''}`;
  return padCells(colored, o.width - clock.length - 1) + p.dim(clock) + ' ';
}

function notices(st: WatchState, o: RenderOpts, p: Palette): string[] {
  const out: string[] = [];
  if (st.error) {
    const retry = st.retryAt === undefined ? '' : ` · retrying in ${Math.max(0, Math.ceil((st.retryAt - o.now) / 1000))}s`;
    out.push(p.red(fit(` ⚠ ${oneLine(st.error)}${retry}`, o.width)));
  }
  const syncErr = st.snapshot?.sync?.lastError;
  if (syncErr) out.push(p.yellow(fit(` ⚠ last sync failed: ${oneLine(syncErr)}`, o.width)));
  if (st.note) out.push(p.dim(fit(` ${oneLine(st.note)}`, o.width)));
  return out;
}

function stackedHeights(st: WatchState, bodyH: number): [number, number, number] {
  const agentRows = Math.max(1, visibleAgents(st).length + 1);
  const agentsH = Math.min(agentRows + 1, Math.max(3, Math.floor(bodyH * 0.4)));
  const tasksH = Math.min(Math.max(1, liveTasks(st.snapshot?.tasks ?? []).length) + 1, Math.max(2, Math.floor(bodyH * 0.25)));
  return [agentsH, tasksH, bodyH - agentsH - tasksH];
}

function layout(st: WatchState, o: RenderOpts, p: Palette): Layout {
  const header = [headerLine(st, o, p), ...notices(st, o, p)].slice(0, Math.max(1, o.height - 6));
  const bodyH = o.height - header.length - 1;
  if (o.width >= WIDE_WIDTH) {
    const leftW = Math.floor((o.width - SEPARATOR.length) * 0.6);
    const agentRows = Math.max(1, visibleAgents(st).length + 1);
    const agentsH = Math.min(agentRows + 1, Math.max(4, Math.floor(bodyH * 0.6)));
    return {
      wide: true, header,
      agents: { w: leftW, h: agentsH }, tasks: { w: leftW, h: bodyH - agentsH },
      feed: { w: o.width - leftW - SEPARATOR.length, h: bodyH },
    };
  }
  const [a, t, f] = stackedHeights(st, bodyH);
  return { wide: false, header, agents: { w: o.width, h: a }, tasks: { w: o.width, h: t }, feed: { w: o.width, h: f } };
}

/** The furthest the feed can scroll for this state and size (0 when it fits). */
export function maxFeedScroll(st: WatchState, o: RenderOpts): number {
  if (o.width < MIN_WIDTH || o.height < MIN_HEIGHT) return 0;
  const p = makePalette(false);
  const { feed } = layout(st, o, p);
  return Math.max(0, feedLines(st, feed.w, p).length - (feed.h - 1));
}

const HELP = [
  'q, Ctrl+C    quit',
  '↑ ↓  k j     scroll the activity feed',
  'PgUp PgDn    scroll a page',
  'Home End     newest / oldest activity',
  'r            refresh now',
  'a            toggle only active agents',
  '?  Esc       close this help',
  '',
  '● active  ◐ idle  ○ offline   ⠋ working = active on an in-progress task',
  '★ orchestrator   you = an agent of this repo',
  'LAST = time since the agent\'s last event (or last seen)',
];

function footer(st: WatchState, o: RenderOpts, p: Palette): string {
  const keys = ` q quit  ↑↓ scroll  r refresh  a ${st.onlyActive ? 'show all' : 'only active'}  ? help`;
  const updated = st.updatedAt === undefined ? 'loading…' : `updated ${age(st.updatedAt, o.now)} ago`;
  const right = `${updated} `;
  return p.dim(fit(keys, Math.max(0, o.width - right.length)) + right.slice(0, o.width));
}

function tooSmall(o: RenderOpts, p: Palette): string {
  const msg = [' agentteams watch', ` Terminal too small: ${o.width}x${o.height}`, ` Needs at least ${MIN_WIDTH}x${MIN_HEIGHT}.`, ' Press q to quit.'];
  return box(msg.map((l, i) => (i === 0 ? p.bold(fit(l, o.width)) : fit(l, o.width))), o.width, o.height).join('\n');
}

function body(st: WatchState, l: Layout, o: RenderOpts, ctx: PanelCtx, scroll: number): string[] {
  if (st.help) return box([titleLine('Help', 'press ? to close', o.width, ctx.p), ...HELP.map((h) => fit(`  ${h}`, o.width))], o.width, l.feed.h + (l.wide ? 0 : l.agents.h + l.tasks.h));
  const agents = agentsPanel(st, l.agents.w, l.agents.h, ctx);
  const tasks = tasksPanel(st, l.tasks.w, l.tasks.h, ctx);
  const feed = feedPanel(st, l.feed.w, l.feed.h, scroll, ctx);
  if (!l.wide) return [...agents, ...tasks, ...feed];
  const left = [...agents, ...tasks];
  return feed.map((f, i) => left[i]! + ctx.p.dim(SEPARATOR) + f);
}

export function renderFrame(st: WatchState, o: RenderOpts): string {
  const p = makePalette(o.color);
  if (o.width < MIN_WIDTH || o.height < MIN_HEIGHT) return tooSmall(o, p);
  const l = layout(st, o, p);
  const scroll = Math.min(Math.max(0, st.scroll), maxFeedScroll(st, o));
  const lines = [...l.header, ...body(st, l, o, { p, now: o.now }, scroll), footer(st, o, p)];
  return lines.join('\n');
}
