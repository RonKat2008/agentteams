import { describe, expect, it } from 'vitest';
import type { AgentView, TeamStatus } from '@agentteams/shared';
import { colorEnabled, makePalette, padVisible } from '../src/color.js';
import { formatStatusTable } from '../src/statusTable.js';

const agent = (over: Partial<AgentView>): AgentView => ({
  name: 'alice-claude', member: 'alice', tool: 'claude', presence: 'active', lastSeenAt: null, isOrchestrator: false,
  currentTask: null, claims: [], githubLogin: null, githubId: null, ...over,
});
const status: TeamStatus = {
  team: { name: 'shop-api', repo: { provider: 'local', defaultBranch: 'main' }, orchestrator: 'alice-claude' },
  agents: [
    agent({ isOrchestrator: true }),
    agent({ name: 'jamie-claude', member: 'jamie', currentTask: { number: 1, title: 'Rate-limit POST /login', status: 'in_progress' }, claims: ['src/auth/**', 'web/a.ts'] }),
    agent({ name: 'kai-cursor', member: 'kai', tool: 'cursor', presence: 'idle', currentTask: { number: 2, title: 'Show order total on checkout page', status: 'in_progress' } }),
    agent({ name: 'sam-gemini', member: 'sam', tool: 'gemini', presence: 'offline' }),
  ],
};

describe('formatStatusTable', () => {
  it('renders a header, glyphs, truncation and notes with color off', () => {
    const lines = formatStatusTable(status, 'alice-claude');
    expect(lines[0]).toBe('shop-api · orchestrator alice-claude');
    expect(lines[2]).toMatch(/^ {2}AGENT +PERSON +TOOL +STATUS +TASK +CLAIMS$/);
    expect(lines[3]).toMatch(/^● alice-claude +alice +claude +active +— +— +★ orchestrator · you$/);
    expect(lines[4]).toMatch(/^● jamie-claude .*#1 Rate-limit POST \/login +src\/auth\/\*\*, web\/a\.ts$/);
    expect(lines[5]).toContain('◐ kai-cursor');
    expect(lines[5]).toContain('#2 Show order total on checkout pa…');
    expect(lines[6]).toMatch(/^○ sam-gemini/);
    expect(lines.join('\n')).not.toContain('\u001b');
  });
  it('aligns columns identically with color on', () => {
    const plain = formatStatusTable(status, 'alice-claude');
    const colored = formatStatusTable(status, 'alice-claude', makePalette(true));
    expect(colored.join('\n')).toContain('\u001b[');
    expect(colored.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ''))).toEqual(plain);
  });
  it('sanitises hub-supplied names', () => {
    const evil: TeamStatus = { ...status, team: { ...status.team, name: 'a\nb' }, agents: [agent({ name: 'x\ny' })] };
    expect(formatStatusTable(evil, 'me').every((l) => !l.includes('\n'))).toBe(true);
  });
});

describe('color helpers', () => {
  it('detects color support', () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
    expect(colorEnabled({ NO_COLOR: '1' }, true)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: '1' }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: '0' }, false)).toBe(false);
  });
  it('picks a stable agent color and pads on visible width', () => {
    const p = makePalette(true);
    expect(p.agent('kai-cursor')).toBe(p.agent('kai-cursor'));
    expect(padVisible(p.green('ab'), 5).replace(/\u001b\[[0-9;]*m/g, '')).toBe('ab   ');
  });
});
