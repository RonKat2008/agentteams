import type { ActivityEvent } from '@agentteams/shared';
import { oneLine } from './format.js';

const MAX_VALUE = 40;
const MAX_TEXT = 60;

type Data = Record<string, unknown>;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Hub-supplied value as a safe single-line string, or undefined when absent. */
function str(v: unknown, max = MAX_TEXT): string | undefined {
  if (typeof v === 'string') return clip(oneLine(v), max);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function list(v: unknown): string | undefined {
  if (typeof v === 'string') return str(v, MAX_TEXT);
  if (!Array.isArray(v)) return undefined;
  const items = v.map((x) => str(x, MAX_TEXT)).filter((x): x is string => x !== undefined);
  return items.length > 0 ? items.join(', ') : undefined;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const quoted = (s: string | undefined): string => (s === undefined ? '' : ` "${s}"`);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function task(d: Data): string | undefined {
  const n = str(d.task);
  return n === undefined ? undefined : `#${n}`;
}

function taskWithTitle(d: Data): string | undefined {
  const t = task(d);
  return t === undefined ? undefined : `${t}${quoted(str(d.title))}`;
}

function commitStats(d: Data): string | undefined {
  const files = num(d.files);
  const ins = num(d.insertions);
  const del = num(d.deletions);
  if (files === undefined || ins === undefined || del === undefined) return undefined;
  return `(${plural(files, 'file')}, +${ins} −${del})`;
}

type Describer = (d: Data) => string | undefined;

const DESCRIBERS: Record<ActivityEvent['type'], Describer> = {
  team_created: (d) => (str(d.name) ? `created team "${str(d.name)}"` : undefined),
  agent_joined: (d) => {
    const tool = str(d.tool);
    const member = str(d.member);
    if (!tool || !member) return undefined;
    const gh = str(d.githubLogin);
    return `joined (${tool}, member ${member}${gh ? `, @${gh}` : ''})`;
  },
  orchestrator_changed: (d) => (str(d.to) ? `made ${str(d.to)} the orchestrator` : undefined),
  invite_rotated: () => 'rotated the invite code',
  invite_revoked: () => 'revoked the invite code',
  task_created: (d) => {
    const t = taskWithTitle(d);
    if (!t) return undefined;
    const to = str(d.assignee);
    return `created ${t}${to ? ` → ${to}` : ''}`;
  },
  task_assigned: (d) => (task(d) && str(d.assignee) ? `assigned ${task(d)} → ${str(d.assignee)}` : undefined),
  task_claimed: (d) => {
    const t = taskWithTitle(d);
    return t ? `started ${t}` : undefined;
  },
  task_updated: (d) => {
    const t = task(d);
    if (!t) return undefined;
    const status = str(d.status);
    const note = str(d.note);
    return `updated ${t}${status ? ` → ${status}` : ''}${note ? `: ${note}` : ''}`;
  },
  task_completed: (d) => {
    const t = task(d);
    if (!t) return undefined;
    const summary = str(d.summary);
    return summary ? `finished ${t}: ${summary}` : `finished ${t}`;
  },
  files_claimed: (d) => (list(d.globs) ? `claimed ${list(d.globs)}${d.exclusive === false ? ' (shared)' : ''}` : undefined),
  files_released: (d) => (list(d.globs) ? `released ${list(d.globs)}` : undefined),
  commit: (d) => {
    const sha = str(d.sha);
    const branch = str(d.branch);
    if (!sha || !branch) return undefined;
    const stats = commitStats(d);
    return `committed ${sha.slice(0, 7)} on ${branch}${quoted(str(d.subject))}${stats ? ` ${stats}` : ''}`;
  },
  message_sent: (d) => {
    const kind = str(d.kind);
    const to = str(d.to);
    if (!kind || !to) return undefined;
    const preview = str(d.preview);
    return `${kind} → ${to}${preview ? `: "${preview}"` : ''}`;
  },
  merged: (d) => {
    const t = task(d);
    if (!t) return undefined;
    const pr = str(d.pr);
    const branch = str(d.branch);
    return `merged ${t}${branch ? ` (${branch})` : ''}${pr ? `: ${pr}` : ''}`;
  },
  claim_overridden: (d) => {
    const paths = list(d.paths);
    const owners = list(d.owners);
    if (!paths) return undefined;
    return `committed over claimed files ${paths}${owners ? ` (held by ${owners})` : ''}`;
  },
};

/** `<type> key=value ...` fallback for unknown types or malformed data. */
function fallback(type: string, data: unknown): string {
  const pairs = data !== null && typeof data === 'object' && !Array.isArray(data)
    ? Object.entries(data as Data).map(([k, v]) => `${oneLine(k)}=${clip(oneLine(typeof v === 'string' ? v : safeJson(v)), MAX_VALUE)}`)
    : [];
  return [oneLine(String(type)), ...pairs].join(' ');
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Plain-text description of an event; never throws. */
export function describeEvent(e: ActivityEvent): string {
  const describer = (DESCRIBERS as Record<string, Describer | undefined>)[e.type];
  const data = e.data !== null && typeof e.data === 'object' && !Array.isArray(e.data) ? e.data : undefined;
  try {
    return (describer && data ? describer(data) : undefined) ?? fallback(e.type, e.data);
  } catch {
    return fallback(e.type, undefined);
  }
}
