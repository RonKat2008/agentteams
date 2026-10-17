import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEvent, TaskView, TeamStatus } from '@agentteams/shared';
import { watchCommand } from '../src/commands/watch.js';
import { saveCredential, type Credential } from '../src/credentials.js';
import { main } from '../src/main.js';
import type { Screen } from '../src/watch/loop.js';
import { menuChoices } from '../src/tui/menu.js';
import { makeTestCli, type TestCli } from './helpers.js';

const status: TeamStatus = {
  team: { name: 'shop-api', repo: { provider: 'local', defaultBranch: 'main' }, orchestrator: 'alice-claude' },
  agents: [
    { name: 'alice-claude', member: 'alice', tool: 'claude', presence: 'active', lastSeenAt: null, isOrchestrator: true, currentTask: null, claims: [], githubLogin: null, githubId: null },
    { name: 'jamie-claude', member: 'jamie', tool: 'claude', presence: 'active', lastSeenAt: null, isOrchestrator: false, currentTask: { number: 1, title: 'Rate-limit POST /login', status: 'in_progress' }, claims: ['src/auth/**'], githubLogin: null, githubId: null },
  ],
};
const tasks: TaskView[] = [{
  number: 1, title: 'Rate-limit POST /login', description: '', status: 'in_progress', assignee: 'jamie-claude',
  branch: null, summary: null, mergedAt: null, createdAt: '2026-10-17T11:00:00.000Z', updatedAt: '2026-10-17T11:00:00.000Z',
}];
const events: ActivityEvent[] = [
  { id: 'e1', type: 'task_claimed', agent: 'jamie-claude', data: { task: 1, title: 'Rate-limit POST /login' }, createdAt: '2026-10-17T11:59:00.000Z' },
];

let t: TestCli;
afterEach(() => t?.cleanup());

/** A hub that answers the three read routes; `fail` makes every request throw. */
function fakeHub(t: TestCli, state: { fail?: boolean; paths: string[] } = { paths: [] }) {
  t.deps.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    state.paths.push(url.pathname);
    if (state.fail) throw new Error('connect ECONNREFUSED');
    const body = url.pathname.endsWith('/status') ? status : url.pathname.endsWith('/tasks') ? tasks : events;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return state;
}

const cred = (over: Partial<Credential> = {}): Credential => ({
  repoPath: t.deps.cwd, tool: 'claude', hubUrl: 'http://hub.test', teamName: 'shop-api', agentName: 'alice-claude',
  apiKey: 'at_secret', createdAt: '2026-10-01T00:00:00.000Z', ...over,
});

function fakeScreen() {
  const calls: string[] = [];
  let onKey: ((d: string) => void) | undefined;
  const writes: string[] = [];
  const screen: Screen = {
    size: () => ({ width: 100, height: 30 }), write: (s) => writes.push(s),
    enter: () => calls.push('enter'), restore: () => calls.push('restore'),
    onKey: (cb) => { onKey = cb; return () => {}; }, onResize: () => () => {},
  };
  return { screen, calls, writes, key: (d: string) => onKey?.(d) };
}

describe('agentteams watch', () => {
  it('prints one snapshot and exits when stdout is not a terminal', async () => {
    t = makeTestCli();
    fakeHub(t);
    await saveCredential(t.deps, cred());
    expect(await main(['node', 'agentteams', 'watch'], t.deps)).toBe(0);
    const out = t.out.join('\n');
    expect(out).toContain('shop-api');
    expect(out).toMatch(/jamie-claude .*#1 Rate-limit POST \/login/);
    expect(out).toContain('Tasks: open 0 · in progress 1 · done 0 · merged 0');
    expect(out).toContain('started #1 "Rate-limit POST /login"');
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('at_secret');
  });

  it('--once prints a snapshot even in a terminal', async () => {
    t = makeTestCli({ isTTY: true });
    fakeHub(t);
    await saveCredential(t.deps, cred());
    expect(await main(['node', 'agentteams', 'watch', '--once'], t.deps)).toBe(0);
    expect(t.out.join('\n')).toContain('Recent activity');
  });

  it('runs the live dashboard in a terminal and restores it on q', async () => {
    t = makeTestCli({ isTTY: true });
    const hub = fakeHub(t);
    await saveCredential(t.deps, cred());
    const s = fakeScreen();
    const done = watchCommand(t.deps, { interval: 1 }, { screen: s.screen });
    await vi.waitFor(() => expect(s.writes.join('')).toContain('jamie-claude'), { timeout: 10_000 });
    expect(hub.paths).toEqual(expect.arrayContaining(['/api/team/status', '/api/team/tasks', '/api/team/activity']));
    s.key('q');
    await done;
    expect(s.calls).toEqual(['enter', 'restore']);
  });

  it('keeps running and shows the error when the hub is down', async () => {
    t = makeTestCli({ isTTY: true });
    fakeHub(t, { fail: true, paths: [] });
    await saveCredential(t.deps, cred());
    const s = fakeScreen();
    const done = watchCommand(t.deps, { interval: 1 }, { screen: s.screen });
    await vi.waitFor(() => expect(s.writes.join('').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')).toContain('cannot reach the agentteams hub at http://hub.test'), { timeout: 10_000 });
    s.key('q');
    await done;
  });

  it('picks a team with --team and names the others otherwise', async () => {
    t = makeTestCli();
    fakeHub(t);
    await saveCredential(t.deps, cred());
    await saveCredential(t.deps, cred({ tool: 'codex', agentName: 'alice-codex', teamName: 'other', hubUrl: 'http://other.test' }));
    expect(await main(['node', 'agentteams', 'watch'], t.deps)).toBe(0);
    expect(t.err.join('\n')).toContain('--team other');
    t.err.length = 0;
    expect(await main(['node', 'agentteams', 'watch', '--team', 'nope'], t.deps)).toBe(1);
    expect(t.err.join('\n')).toContain('no team "nope" in this repo; teams here: "shop-api", "other"');
  });

  it('rejects an interval under 1 second', async () => {
    t = makeTestCli();
    expect(await main(['node', 'agentteams', 'watch', '--interval', '0.5'], t.deps)).toBe(1);
    expect(t.err.join('\n')).toContain('--interval');
  });

  it('is offered in the menu only when this repo has a team', () => {
    expect(menuChoices(true).some((c) => c.value === 'watch' && c.label === 'Watch the team live')).toBe(true);
    expect(menuChoices(false).some((c) => c.value === 'watch')).toBe(false);
  });
});
