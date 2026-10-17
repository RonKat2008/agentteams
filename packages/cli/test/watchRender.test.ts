import { describe, expect, it } from 'vitest';
import type { ActivityEvent, AgentView, TaskView } from '@agentteams/shared';
import { initialState, taskCounts, transportLabel, ago, type Snapshot, type WatchState } from '../src/watch/model.js';
import { maxFeedScroll, renderFrame, type RenderOpts } from '../src/watch/render.js';
import { charWidth, fit, stripAnsi, textWidth, truncate, wrapText } from '../src/watch/text.js';

process.env.TZ = 'UTC';
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const at = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();

const agent = (over: Partial<AgentView>): AgentView => ({
  name: 'alice-claude', member: 'alice', tool: 'claude', presence: 'active', lastSeenAt: at(5), isOrchestrator: false,
  currentTask: null, claims: [], githubLogin: null, githubId: null, ...over,
});
const task = (n: number, title: string, status: TaskView['status'], assignee: string | null, mergedAt: string | null = null): TaskView => ({
  number: n, title, description: '', status, assignee, branch: null, summary: null, mergedAt, createdAt: at(600), updatedAt: at(60),
});
const ev = (secAgo: number, agentName: string, type: ActivityEvent['type'], data: Record<string, unknown>): ActivityEvent => ({
  id: `e${secAgo}`, type, agent: agentName, data, createdAt: at(secAgo),
});

function snapshot(): Snapshot {
  return {
    status: {
      team: { name: 'shop-api', repo: { provider: 'local', defaultBranch: 'main' }, orchestrator: 'alice-claude' },
      agents: [
        agent({ isOrchestrator: true }),
        agent({ name: 'jamie-claude', member: 'jamie', currentTask: { number: 1, title: 'Rate-limit POST /login', status: 'in_progress' }, claims: ['src/auth/**'] }),
        agent({ name: 'kai-cursor', member: 'kai', tool: 'cursor', presence: 'idle', currentTask: { number: 2, title: 'Show order total on checkout', status: 'in_progress' }, claims: ['web/Checkout.tsx'] }),
        agent({ name: 'sam-gemini', member: 'sam', tool: 'gemini', presence: 'offline', lastSeenAt: at(7200) }),
      ],
    },
    tasks: [
      task(1, 'Rate-limit POST /login', 'in_progress', 'jamie-claude'),
      task(2, 'Show order total on checkout', 'in_progress', 'kai-cursor'),
      task(3, 'Tests for the orders API', 'assigned', 'sam-gemini'),
      task(4, 'Old work', 'done', 'alice-claude', at(3000)),
      task(5, 'Finished, not merged', 'done', 'jamie-claude'),
    ],
    events: [
      ev(120, 'alice-claude', 'task_created', { task: 1, title: 'Rate-limit POST /login', assignee: 'jamie-claude' }),
      ev(90, 'jamie-claude', 'task_claimed', { task: 1, title: 'Rate-limit POST /login' }),
      ev(60, 'sam-gemini', 'message_sent', { kind: 'question', to: 'alice-claude', body: 'Should order tests use the in-memory store? Or the real database we run in CI on every push?' }),
      ev(30, 'alice-claude', 'message_sent', { kind: 'command', to: 'sam-gemini', body: 'Yes, in-memory.\nReal DB only in CI.' }),
    ],
    sync: { lastFetchAt: at(4), lastError: null },
  };
}

const state = (over: Partial<WatchState> = {}): WatchState => ({
  ...initialState('shared via /tmp/remote.git', ['alice-claude', 'alice-codex']),
  snapshot: snapshot(), updatedAt: NOW - 1000, ...over,
});
const opts = (width: number, height: number, over: Partial<RenderOpts> = {}): RenderOpts => ({ width, height, color: false, now: NOW, ...over });
const lines = (frame: string) => frame.split('\n');

function expectExactSize(frame: string, width: number, height: number) {
  const ls = lines(frame);
  expect(ls).toHaveLength(height);
  for (const l of ls) expect(textWidth(l)).toBe(width);
}

describe('text helpers', () => {
  it('counts wide characters as two cells and combining marks as none', () => {
    expect(charWidth('a')).toBe(1);
    expect(charWidth('漢')).toBe(2);
    expect(charWidth('🚀')).toBe(2);
    expect(textWidth('é')).toBe(1);
    expect(textWidth('\u001b[32m●\u001b[39m')).toBe(1);
  });
  it('truncates with an ellipsis on cell width and pads exactly', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('漢字漢字', 5)).toBe('漢字…');
    expect(textWidth(fit('漢字漢字', 5))).toBe(5);
    expect(fit('ab', 4)).toBe('ab  ');
  });
  it('wraps words and splits ones wider than a line', () => {
    expect(wrapText('one two three', 7)).toEqual(['one two', 'three']);
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('a\n\nb', 10)).toEqual(['a', 'b']);
  });
});

describe('model', () => {
  it('counts open, in progress, done (not merged) and merged tasks', () => {
    expect(taskCounts(snapshot().tasks)).toEqual({ open: 1, inProgress: 2, done: 1, merged: 1 });
  });
  it('formats ages', () => {
    expect(ago(NOW - 500, NOW)).toBe('now');
    expect(ago(NOW - 12_000, NOW)).toBe('12s');
    expect(ago(NOW - 300_000, NOW)).toBe('5m');
    expect(ago(undefined, NOW)).toBe('—');
  });
  it('labels transports without leaking URL credentials', () => {
    const base = { repoPath: '/r', tool: 'claude' as const, hubUrl: 'https://u:secret@hub.example.com/x', teamName: 't', agentName: 'a', apiKey: 'k', createdAt: '' };
    expect(transportLabel(base)).toBe('hub hub.example.com');
    expect(transportLabel({ ...base, transport: 'local' })).toBe('this computer');
    const git = { teamId: 't', agentId: 'a', remote: 'https://x-token:ghp_secret@github.com/o/r.git', teamKey: '', publicKey: '', privateKey: '' };
    expect(transportLabel({ ...base, transport: 'git', git })).toBe('shared via https://github.com/o/r.git');
  });
});

describe('renderFrame', () => {
  it('80x24: header, agents, tasks, feed and footer, every line exactly 80 cells', () => {
    const frame = renderFrame(state(), opts(80, 24));
    expectExactSize(frame, 80, 24);
    expect(frame).toMatchSnapshot();
    const ls = lines(frame);
    expect(ls[0]).toContain('shop-api');
    expect(ls[0]).toContain('shared via /tmp/remote.…');
    expect(ls[0]).toContain('synced 4s ago');
    expect(ls[0]).toContain('★ alice-claude');
    expect(ls[0]!.trimEnd().endsWith('12:00:00')).toBe(true);
    expect(frame).toMatch(/● alice-claude .*you/);
    expect(frame).toMatch(/● jamie-claude .*working.*#1 Rate-limit/);
    expect(frame).toContain('open 1 · in progress 2 · done 1 · merged 1');
    expect(frame).toContain('q quit');
  });

  it('120x40: side-by-side panels with whole message bodies wrapped in the feed', () => {
    const frame = renderFrame(state(), opts(120, 40));
    expectExactSize(frame, 120, 40);
    expect(frame).toMatchSnapshot();
    expect(frame).toContain('│');
    expect(lines(frame)[0]).toContain('shop-api · shared via /tmp/remote.git · synced 4s ago · ★ alice-claude');
    expect(frame).toContain('Real DB only in CI.');
    expect(frame).toContain('push?"');
  });

  it('shows newest events first', () => {
    const frame = renderFrame(state(), opts(120, 40));
    expect(frame.indexOf('command → sam-gemini')).toBeLessThan(frame.indexOf('created #1'));
  });

  it('falls back to a message on a tiny terminal', () => {
    const frame = renderFrame(state(), opts(30, 8));
    expectExactSize(frame, 30, 8);
    expect(frame).toContain('too small');
    expect(frame).toMatchSnapshot();
  });

  it('truncates long names and titles with …', () => {
    const s = snapshot();
    s.status.agents[1] = agent({ name: 'jamie-claude-with-a-very-long-agent-name', currentTask: { number: 1, title: 'A'.repeat(200), status: 'in_progress' } });
    s.tasks[0] = task(1, 'B'.repeat(200), 'in_progress', 'jamie-claude-with-a-very-long-agent-name');
    const frame = renderFrame(state({ snapshot: s }), opts(80, 24));
    expectExactSize(frame, 80, 24);
    expect(frame).toMatch(/jamie-claude-with-a…/);
    expect(frame).toMatch(/#1 A+…/);
    expect(frame).toMatch(/#1 {1,2}B+…/);
  });

  it('keeps alignment with wide unicode', () => {
    const s = snapshot();
    s.status.team.name = '商店-api 🚀';
    s.status.agents[0] = agent({ name: '小明-claude', isOrchestrator: true, currentTask: { number: 7, title: '修复登录页面的错误', status: 'in_progress' } });
    for (const [w, h] of [[80, 24], [120, 40]] as const) expectExactSize(renderFrame(state({ snapshot: s }), opts(w, h)), w, h);
  });

  it('strips control characters from hub data', () => {
    const s = snapshot();
    s.status.team.name = 'evil\u001b[2J\u0007team';
    s.status.agents[0] = agent({ name: 'bad\nname\u001b]0;x\u0007' });
    s.events.push(ev(1, 'x\u001b[31my', 'message_sent', { kind: 'fyi', to: 'all', body: 'hi\u001b[2Jthere\rnow\u0000' }));
    const frame = renderFrame(state({ snapshot: s }), opts(120, 40));
    expect(frame).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    expectExactSize(frame, 120, 40);
  });

  it('colors with ANSI only when color is on, same text either way', () => {
    const plain = renderFrame(state(), opts(100, 30));
    const colored = renderFrame(state(), opts(100, 30, { color: true }));
    expect(plain).not.toContain('\u001b');
    expect(colored).toContain('\u001b[');
    expect(stripAnsi(colored)).toBe(plain);
  });

  it('shows a poll error in the header and keeps the last data', () => {
    const frame = renderFrame(state({ error: 'hub unreachable: ECONNREFUSED', retryAt: NOW + 8000 }), opts(80, 24));
    expect(lines(frame)[1]).toContain('hub unreachable: ECONNREFUSED');
    expect(lines(frame)[1]).toContain('retrying in 8s');
    expect(frame).toContain('jamie-claude');
  });

  it('says it is loading before the first snapshot', () => {
    const frame = renderFrame({ ...initialState('this computer', []) }, opts(80, 24));
    expectExactSize(frame, 80, 24);
    expect(frame).toContain('Loading');
  });

  it('hides non-active agents when toggled', () => {
    const frame = renderFrame(state({ onlyActive: true }), opts(80, 24));
    expect(frame).not.toMatch(/○ sam-gemini/);
    expect(frame).toMatch(/Agents · only active \(2 of 4\)/);
    expect(frame).not.toMatch(/◐ kai-cursor/);
  });

  it('scrolls the feed toward older events and clamps at the end', () => {
    const s = snapshot();
    s.events = Array.from({ length: 60 }, (_, i) => ev(600 - i, 'kai-cursor', 'files_claimed', { globs: [`f${i}.ts`] }));
    const st = state({ snapshot: s });
    const top = renderFrame(st, opts(80, 24));
    expect(top).toContain('f59.ts');
    const max = maxFeedScroll(st, opts(80, 24));
    expect(max).toBeGreaterThan(0);
    const bottom = renderFrame({ ...st, scroll: max + 100 }, opts(80, 24));
    expect(bottom).toContain('f0.ts');
    expect(bottom).not.toContain('f59.ts');
  });

  it('shows the help panel', () => {
    const frame = renderFrame(state({ help: true }), opts(80, 24));
    expectExactSize(frame, 80, 24);
    expect(frame).toContain('toggle only active agents');
  });

  it('notes other teams and git sync failures', () => {
    const s = snapshot();
    s.sync = { lastFetchAt: at(4), lastError: 'fetch failed' };
    const frame = renderFrame(state({ snapshot: s, note: 'also in "other": --team other' }), opts(100, 30));
    expect(frame).toContain('last sync failed: fetch failed');
    expect(frame).toContain('--team other');
  });
});
