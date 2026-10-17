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
  /** Visible text of the last full frame written. */
  last: () => string;
}

function fakeScreen(width = 80, height = 24): FakeScreen {
  let size = { width, height };
  let onKey: ((d: string) => void) | undefined;
  let onResize: (() => void) | undefined;
  const writes: string[] = [];
  const calls: string[] = [];
  return {
    writes, calls,
    size: () => size,
    write: (s) => writes.push(s),
    enter: () => calls.push('enter'),
    restore: () => calls.push('restore'),
    onKey: (cb) => { onKey = cb; return () => { onKey = undefined; }; },
    onResize: (cb) => { onResize = cb; return () => { onResize = undefined; }; },
    key: (d) => onKey?.(d),
    resize: (w, h) => { size = { width: w, height: h }; onResize?.(); },
    last: () => (writes.filter((w) => w.includes('\u001b[1;1H')).at(-1) ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''),
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
