import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamStatus } from '@agentteams/shared';
import { parseKeys } from '../src/watch/keys.js';
import { runWatchLoop, type Screen } from '../src/watch/loop.js';
import { initialState, type Snapshot } from '../src/watch/model.js';

const status: TeamStatus = {
  team: { name: 'shop-api', repo: { provider: 'local', defaultBranch: 'main' }, orchestrator: null },
  agents: [{ name: 'kai-cursor', member: 'kai', tool: 'cursor', presence: 'active', lastSeenAt: null, isOrchestrator: false, currentTask: null, claims: [], githubLogin: null, githubId: null }],
};
const snap = (): Snapshot => ({ status, tasks: [], events: [] });

interface FakeScreen extends Screen {
  writes: string[];
  calls: string[];
  key: (data: string) => void;
  resize: (w: number, h: number) => void;
  /** Visible text of the virtual screen the writes produced, rows joined by newlines. */
  last: () => string;
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Applies the loop's writes (absolute row positioning, clear) to an array of rows. */
function applyWrite(rows: string[], s: string): void {
  if (s.includes('\u001b[2J')) rows.length = 0;
  const parts = s.split(/\u001b\[(\d+);1H/);
  for (let i = 1; i < parts.length; i += 2) rows[Number(parts[i]) - 1] = parts[i + 1]!.replace(ANSI, '');
}

function fakeScreen(width = 80, height = 24): FakeScreen {
  let size = { width, height };
  let onKey: ((d: string) => void) | undefined;
  let onResize: (() => void) | undefined;
  const writes: string[] = [];
  const calls: string[] = [];
  const rows: string[] = [];
  return {
    writes, calls,
    size: () => size,
    write: (s) => { writes.push(s); applyWrite(rows, s); },
    enter: () => calls.push('enter'),
    restore: () => calls.push('restore'),
    onKey: (cb) => { onKey = cb; return () => { onKey = undefined; }; },
    onResize: (cb) => { onResize = cb; return () => { onResize = undefined; }; },
    key: (d) => onKey?.(d),
    resize: (w, h) => { size = { width: w, height: h }; onResize?.(); },
    last: () => rows.join('\n'),
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-17T12:00:00Z')); });
afterEach(() => vi.useRealTimers());

const start = (screen: FakeScreen, fetch: () => Promise<Snapshot>) =>
  runWatchLoop({ screen, fetch, state: initialState('this computer', []), intervalMs: 2000, color: false });

describe('parseKeys', () => {
  it('reads keys and escape sequences from one chunk', () => {
    expect(parseKeys('q')).toEqual(['quit']);
    expect(parseKeys('\u0003')).toEqual(['quit']);
    expect(parseKeys('\u001b[A\u001b[Bj')).toEqual(['up', 'down', 'down']);
    expect(parseKeys('\u001b[5~\u001b[6~ra?')).toEqual(['pageUp', 'pageDown', 'refresh', 'toggleActive', 'help']);
    expect(parseKeys('\u001b')).toEqual(['escape']);
    expect(parseKeys('x')).toEqual([]);
  });
});

describe('runWatchLoop', () => {
  it('enters the alternate screen, renders, and restores the terminal on q', async () => {
    const screen = fakeScreen();
    const done = start(screen, async () => snap());
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.calls).toEqual(['enter']);
    expect(screen.last()).toContain('kai-cursor');
    screen.key('q');
    await done;
    expect(screen.calls).toEqual(['enter', 'restore']);
  });

  it('restores the terminal when stopped by a signal', async () => {
    const screen = fakeScreen();
    const ac = new AbortController();
    const done = runWatchLoop({ screen, fetch: async () => snap(), state: initialState('x', []), intervalMs: 2000, color: false, signal: ac.signal });
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await done;
    expect(screen.calls).toEqual(['enter', 'restore']);
  });

  it('re-renders at the new size on resize', async () => {
    const screen = fakeScreen(80, 24);
    const done = start(screen, async () => snap());
    await vi.advanceTimersByTimeAsync(0);
    screen.resize(120, 30);
    const frame = screen.writes.at(-1)!;
    expect(frame).toContain('\u001b[30;1H'); // the frame now has 30 rows
    screen.resize(20, 5);
    expect(screen.last()).toContain('too small');
    screen.key('q');
    await done;
  });

  it('rewrites only the lines that changed', async () => {
    const screen = fakeScreen();
    const done = start(screen, async () => snap());
    await vi.advanceTimersByTimeAsync(0);
    const before = screen.writes.length;
    screen.key('a');
    const diff = screen.writes.slice(before).join('');
    expect(diff).toContain('only active (1 of 1)');
    expect(diff).not.toContain('\u001b[1;1H'); // the header did not change
    expect(diff).not.toContain('\u001b[2J');
    screen.key('q');
    await done;
  });

  it('shows a client error in the header, keeps running and recovers', async () => {
    const screen = fakeScreen();
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('hub unreachable: ECONNREFUSED');
      return snap();
    });
    const done = start(screen, fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.last()).toContain('hub unreachable: ECONNREFUSED');
    expect(screen.last()).toContain('retrying in');
    await vi.advanceTimersByTimeAsync(4000); // backoff after one failure: 2 × interval
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.last()).not.toContain('ECONNREFUSED');
    expect(screen.last()).toContain('kai-cursor');
    screen.key('q');
    await done;
  });

  it('backs off on repeated errors and refreshes immediately on r', async () => {
    const screen = fakeScreen();
    const fetch = vi.fn(async () => { throw new Error('down'); });
    const done = start(screen, fetch);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7000); // the third waits 8 s
    expect(fetch).toHaveBeenCalledTimes(2);
    screen.key('r');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(3);
    screen.key('q');
    await done;
  });

  it('polls on the interval and toggles help and only-active from keys', async () => {
    const screen = fakeScreen();
    const fetch = vi.fn(async () => snap());
    const done = start(screen, fetch);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
    screen.key('?');
    expect(screen.last()).toContain('toggle only active agents');
    screen.key('\u001b');
    screen.key('a');
    expect(screen.last()).toContain('only active (1 of 1)');
    screen.key('\u0003');
    await done;
    expect(screen.calls.at(-1)).toBe('restore');
  });

  it('restores the terminal even when rendering throws', async () => {
    const screen = fakeScreen();
    const bad = { ...snap(), status: null as unknown as TeamStatus };
    const done = start(screen, async () => bad);
    await expect(done).rejects.toThrow();
    expect(screen.calls).toEqual(['enter', 'restore']);
  });
});
