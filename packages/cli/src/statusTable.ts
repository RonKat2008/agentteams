import type { AgentView, PresenceStatus, TeamStatus } from '@agentteams/shared';
import { makePalette, padVisible, type Palette } from './color.js';
import { oneLine } from './format.js';

const MAX_TASK_TITLE = 32;
const EMPTY = '—';
const HEADERS = ['AGENT', 'PERSON', 'TOOL', 'STATUS', 'TASK', 'CLAIMS'] as const;
const GLYPHS: Record<PresenceStatus, string> = { active: '●', idle: '◐', offline: '○' };

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function glyph(presence: PresenceStatus, p: Palette): string {
  const g = GLYPHS[presence] ?? GLYPHS.offline;
  if (presence === 'active') return p.green(g);
  if (presence === 'idle') return p.yellow(g);
  return p.gray(g);
}

function taskCell(a: AgentView): string {
  return a.currentTask ? `#${a.currentTask.number} ${clip(oneLine(a.currentTask.title), MAX_TASK_TITLE)}` : EMPTY;
}

function cells(a: AgentView): string[] {
  const claims = a.claims.length > 0 ? a.claims.map(oneLine).join(', ') : EMPTY;
  return [oneLine(a.name), oneLine(a.member), oneLine(a.tool), a.presence, taskCell(a), claims];
}

function widths(rows: string[][]): number[] {
  return HEADERS.map((h, i) => Math.max(h.length, ...rows.map((r) => [...r[i]!].length)));
}

function notes(a: AgentView, me: readonly string[], p: Palette): string {
  const parts = [a.isOrchestrator ? p.magenta('★ orchestrator') : '', me.includes(a.name) ? 'you' : ''].filter(Boolean);
  return parts.join(' · ');
}

/** `me`: the local agent(s) on this team, each marked "you". */
export function formatStatusTable(status: TeamStatus, me: string | readonly string[], p: Palette = makePalette(false)): string[] {
  const mine = typeof me === 'string' ? [me] : me;
  const { team, agents } = status;
  const rows = agents.map(cells);
  const w = widths(rows);
  const line = (cols: string[]) => cols.map((c, i) => padVisible(c, w[i]!)).join('  ');
  const head = p.bold(oneLine(team.name)) + p.dim(`${team.repo.slug ? ` · repo ${oneLine(team.repo.slug)}` : ''} · orchestrator ${oneLine(team.orchestrator ?? 'none')}`);
  const header = `  ${p.dim(line([...HEADERS]).trimEnd())}`;
  const body = agents.map((a, i) => {
    const c = rows[i]!;
    const note = notes(a, mine, p);
    return `${glyph(a.presence, p)} ${line([p.agent(c[0]!), ...c.slice(1)])}${note ? `  ${note}` : ''}`.trimEnd();
  });
  return [head, '', header, ...body];
}
