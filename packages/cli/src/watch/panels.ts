/**
 * The dashboard's panels. Each returns exactly `h` lines of exactly `w` cells (colored when the palette is),
 * built from sanitised plain text that is fitted before it is colored.
 */
import type { AgentView, TaskView } from '@agentteams/shared';
import type { Palette } from '../color.js';
import { describeEvent } from '../eventText.js';
import { oneLine } from '../format.js';
import {
  ago, isWorking, lastActivityAt, liveTasks, taskCounts, visibleAgents, type WatchState,
} from './model.js';
import { fit, fitRight, padCells, textWidth, truncate, wrapText } from './text.js';

export interface PanelCtx { p: Palette; now: number }

const GAP = '  ';
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
/** One spinner frame per this many ms of the clock. */
export const SPINNER_MS = 400;
const GLYPHS: Record<string, string> = { active: '●', idle: '◐', offline: '○' };

/** Pads a list of lines with blank ones (or cuts it) to exactly `h` lines of `w` cells. */
export function box(lines: readonly string[], w: number, h: number): string[] {
  const out = lines.slice(0, h).map((l) => padCells(l, w));
  while (out.length < h) out.push(' '.repeat(w));
  return out;
}

/** `── Title · extra ─────` across the panel. */
export function titleLine(title: string, extra: string, w: number, p: Palette): string {
  const text = truncate(`── ${title}${extra ? ` · ${extra}` : ''} `, w);
  const fill = '─'.repeat(Math.max(0, w - textWidth(text)));
  const cut = text.startsWith('── ') ? 3 : 0;
  return p.dim(text.slice(0, cut)) + p.bold(text.slice(cut, cut + title.length)) + p.dim(text.slice(cut + title.length) + fill);
}

const spinner = (now: number): string => SPINNER[Math.floor(now / SPINNER_MS) % SPINNER.length]!;

function dot(a: AgentView, p: Palette): string {
  const g = GLYPHS[a.presence] ?? GLYPHS.offline!;
  return a.presence === 'active' ? p.green(g) : a.presence === 'idle' ? p.yellow(g) : p.gray(g);
}

interface AgentCols { name: number; tool: number; state: number; task: number; claims: number; age: number; tags: number }

const longest = (xs: string[], min: number, max: number): number => Math.min(max, Math.max(min, ...xs.map(textWidth)));

/** Column widths for the agent rows; tool and claims columns drop out on narrow panels. */
function agentCols(agents: readonly AgentView[], w: number): AgentCols {
  const name = longest(agents.map((a) => oneLine(a.name)), 5, 20);
  let tool = longest(agents.map((a) => oneLine(a.tool)), 4, 8);
  const fixed = (t: number) => 2 + name + 2 + (t ? t + 2 : 0) + 9 + 2 + 2 + 4 + 2 + 5;
  if (w - fixed(tool) < 14) tool = 0;
  const rest = Math.max(1, w - fixed(tool));
  if (rest < 28) return { name, tool, state: 9, task: rest, claims: 0, age: 4, tags: 5 };
  const task = Math.ceil(rest * 0.62);
  return { name, tool, state: 9, task, claims: rest - task - 2, age: 4, tags: 5 };
}

function tagsOf(a: AgentView, mine: readonly string[]): string {
  return [a.isOrchestrator ? '★' : '', mine.includes(a.name) ? 'you' : ''].filter(Boolean).join(' ');
}

function agentRow(a: AgentView, c: AgentCols, st: WatchState, ctx: PanelCtx): string {
  const { p, now } = ctx;
  const working = isWorking(a);
  const stateText = fit(working ? `${spinner(now)} working` : a.presence, c.state);
  const task = a.currentTask ? `#${a.currentTask.number} ${oneLine(a.currentTask.title)}` : '—';
  const tags = fit(tagsOf(a, st.mine), c.tags);
  const cells = [
    p.agent(fit(oneLine(a.name), c.name)),
    ...(c.tool ? [fit(oneLine(a.tool), c.tool)] : []),
    working ? p.cyan(stateText) : p.dim(stateText),
    fit(task, c.task),
    ...(c.claims ? [p.dim(fit(a.claims.map(oneLine).join(', ') || '—', c.claims))] : []),
    p.dim(fitRight(ago(lastActivityAt(a, st.snapshot?.events ?? []), now), c.age)),
    p.magenta(tags.replace(/you/, p.bold('you'))),
  ];
  return `${dot(a, p)} ${cells.join(GAP)}`;
}

function agentHeader(c: AgentCols, p: Palette): string {
  const cols = [fit('AGENT', c.name), ...(c.tool ? [fit('TOOL', c.tool)] : []), fit('STATE', c.state), fit('TASK', c.task),
    ...(c.claims ? [fit('CLAIMS', c.claims)] : []), fitRight('LAST', c.age)];
  return p.dim(`  ${cols.join(GAP)}`);
}

export function agentsPanel(st: WatchState, w: number, h: number, ctx: PanelCtx): string[] {
  const all = st.snapshot?.status.agents ?? [];
  const agents = visibleAgents(st);
  const extra = st.onlyActive ? `only active (${agents.length} of ${all.length})` : String(all.length);
  const lines = [titleLine('Agents', extra, w, ctx.p)];
  if (!st.snapshot) return box([...lines, ctx.p.dim('  Loading…')], w, h);
  if (agents.length === 0) return box([...lines, ctx.p.dim(st.onlyActive ? '  No active agents (press a to show all)' : '  No agents yet')], w, h);
  const c = agentCols(agents, w);
  const room = h - 2;
  const shown = agents.length > room ? agents.slice(0, Math.max(0, room - 1)) : agents;
  lines.push(agentHeader(c, ctx.p), ...shown.map((a) => agentRow(a, c, st, ctx)));
  if (shown.length < agents.length) lines.push(ctx.p.dim(`  +${agents.length - shown.length} more`));
  return box(lines.map((l) => truncateColored(l, w)), w, h);
}

/** Colored lines are built to fit; this only guards against an off-by-one producing an overlong line. */
const truncateColored = (l: string, w: number): string => (textWidth(l) <= w ? l : truncate(l.replace(/\u001b\[[0-9;]*m/g, ''), w));

export const TASK_GLYPHS: Record<string, string> = { in_progress: '▶', blocked: '■' };

function taskRow(t: TaskView, numW: number, assigneeW: number, w: number, p: Palette): string {
  const glyph = TASK_GLYPHS[t.status] ?? '○';
  const who = t.assignee ? oneLine(t.assignee) : 'unassigned';
  const label = t.status === 'blocked' ? ' (blocked)' : '';
  const titleW = Math.max(1, w - 2 - numW - 1 - assigneeW - 2);
  const title = fit(`${oneLine(t.title)}${label}`, titleW);
  const g = t.status === 'in_progress' ? p.cyan(glyph) : t.status === 'blocked' ? p.red(glyph) : p.dim(glyph);
  return `${g} ${fit(`#${t.number}`, numW)} ${title}  ${t.assignee ? p.agent(fit(who, assigneeW)) : p.dim(fit(who, assigneeW))}`;
}

export function tasksPanel(st: WatchState, w: number, h: number, ctx: PanelCtx): string[] {
  const tasks = st.snapshot?.tasks ?? [];
  const c = taskCounts(tasks);
  const extra = st.snapshot ? `open ${c.open} · in progress ${c.inProgress} · done ${c.done} · merged ${c.merged}` : '';
  const lines = [titleLine('Tasks', extra, w, ctx.p)];
  const live = liveTasks(tasks);
  if (st.snapshot && live.length === 0) lines.push(ctx.p.dim('  No open tasks'));
  const numW = longest(live.map((t) => `#${t.number}`), 2, 6);
  const assigneeW = Math.min(longest(live.map((t) => oneLine(t.assignee ?? 'unassigned')), 4, 20), Math.floor(w / 3));
  const room = h - 1;
  const shown = live.length > room ? live.slice(0, Math.max(0, room - 1)) : live;
  lines.push(...shown.map((t) => taskRow(t, numW, assigneeW, w, ctx.p)));
  if (shown.length < live.length) lines.push(ctx.p.dim(`  +${live.length - shown.length} more`));
  return box(lines, w, h);
}

function clock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

export const clockText = clock;

/** Every feed line, newest event first, each wrapped to `w` cells. */
export function feedLines(st: WatchState, w: number, p: Palette): string[] {
  const events = [...(st.snapshot?.events ?? [])].reverse();
  const agentW = longest(events.map((e) => oneLine(e.agent ?? '-')), 4, 14);
  const indent = 8 + 1 + agentW + 1;
  const inline = w - indent >= 16;
  return events.flatMap((e) => {
    const head = `${p.dim(clock(Date.parse(e.createdAt)))} ${p.agent(fit(oneLine(e.agent ?? '-'), agentW))} `;
    const text = describeEvent(e);
    const isCommand = e.type === 'message_sent' && text.startsWith('command');
    const paint = (l: string, first: boolean) => (first && isCommand ? p.bold(p.yellow('command')) + l.slice('command'.length) : l);
    if (!inline) return [head, ...wrapText(text, w - 2).map((l, i) => `  ${paint(l, i === 0)}`)].map((l) => padCells(l, w));
    return wrapText(text, w - indent).map((l, i) => padCells(i === 0 ? head + paint(l, true) : ' '.repeat(indent) + l, w));
  });
}

export function feedPanel(st: WatchState, w: number, h: number, scroll: number, ctx: PanelCtx): string[] {
  const all = feedLines(st, w, ctx.p);
  const extra = scroll > 0 ? `scrolled ${scroll} · ↑ for newer` : 'newest first';
  const lines = [titleLine('Activity', extra, w, ctx.p)];
  if (st.snapshot && all.length === 0) lines.push(ctx.p.dim('  No activity yet'));
  lines.push(...all.slice(scroll, scroll + h - 1));
  return box(lines, w, h);
}
