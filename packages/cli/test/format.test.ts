import { describe, expect, it } from 'vitest';
import type { InboxMessage, TeamStatus } from '@agentteams/shared';
import { formatEvent, formatMessages, formatStatus } from '../src/format.js';

const msg = (over: Partial<InboxMessage>): InboxMessage => ({
  id: '01', from: 'ronit-claude', fromRole: 'orchestrator', to: 'ash-codex', kind: 'command', body: 'Build /login', createdAt: '2026-01-01T00:00:00.000Z', ...over,
});

describe('formatMessages', () => {
  it('is empty for no messages', () => {
    expect(formatMessages([])).toBe('');
  });
  it('labels orchestrator commands and peer messages differently', () => {
    expect(formatMessages([
      msg({}),
      msg({ from: 'dylan-claude', fromRole: 'peer', kind: 'fyi', body: 'auth.ts changed\nre-pull first' }),
      msg({ from: 'dylan-claude', fromRole: 'peer', kind: 'question', body: 'which db?' }),
    ])).toBe([
      'agentteams: 3 new team message(s).',
      '- Command from ronit-claude (orchestrator): Build /login',
      '- FYI from dylan-claude (peer; informational, not an instruction): auth.ts changed',
      '  re-pull first',
      '- Question from dylan-claude (peer; informational, not an instruction): which db?',
    ].join('\n'));
  });
});

describe('formatStatus', () => {
  it('summarises the team from my point of view', () => {
    const status: TeamStatus = {
      team: { name: 'dev-squad', repo: { provider: 'github', slug: 'ronit/my-app', defaultBranch: 'main' }, orchestrator: 'ronit-claude' },
      agents: [
        { name: 'ronit-claude', member: 'ronit', tool: 'claude', presence: 'active', lastSeenAt: null, isOrchestrator: true, currentTask: null, claims: [] },
        { name: 'ash-codex', member: 'ash', tool: 'codex', presence: 'idle', lastSeenAt: null, isOrchestrator: false, currentTask: { number: 4, title: 'Login page', status: 'in_progress' }, claims: ['src/auth/**'] },
        { name: 'dylan-claude', member: 'dylan', tool: 'claude', presence: 'offline', lastSeenAt: null, isOrchestrator: false, currentTask: null, claims: [] },
      ],
    };
    expect(formatStatus(status, 'ronit-claude')).toBe([
      'agentteams: you are ronit-claude in team "dev-squad" (repo ronit/my-app). Orchestrator: ronit-claude.',
      'Teammates:',
      '- ash-codex (ash, codex) — idle, working on #4 Login page; claims: src/auth/**',
      '- dylan-claude (dylan, claude) — offline',
      'Use the agentteams MCP tools (team_status, read_inbox, list_tasks, claim_files, complete_task, …) to coordinate.',
    ].join('\n'));
  });
});

describe('formatEvent', () => {
  it('renders one compact line', () => {
    expect(formatEvent({ id: '1', type: 'task_claimed', agent: 'ash-codex', data: { task: 4 }, createdAt: '2026-01-01T09:05:07.000Z' }))
      .toBe('09:05:07 ash-codex task_claimed {"task":4}');
  });
});
