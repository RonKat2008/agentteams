import { describe, expect, it } from 'vitest';
import {
  agentChoices, createOptions, hubFlag, joinOptions, repoChoices, validateHubUrl, validateInviteCode, validateTeamName,
} from '../src/tui/choices.js';
import { DEFAULT_HUB_URL } from '../src/paths.js';

describe('validators', () => {
  it('team names follow the hub rule', () => {
    expect(validateTeamName('my-team')).toBeUndefined();
    expect(validateTeamName('')).toBeDefined();
    expect(validateTeamName('a<b>')).toMatch(/< or >/);
    expect(validateTeamName('x'.repeat(65))).toBeDefined();
  });

  it('invite codes are four groups of four from the hub alphabet', () => {
    expect(validateInviteCode('abcd-efgh-jkmn-pqrs')).toBeUndefined();
    expect(validateInviteCode('  ABCD-EFGH-JKMN-2345 ')).toBeUndefined();
    expect(validateInviteCode('abcd-efgh-jkmn')).toBeDefined();
    expect(validateInviteCode('abc0-efgh-jkmn-pqrs')).toBeDefined(); // 0 is not in the alphabet
    expect(validateInviteCode('')).toBeDefined();
  });

  it('hub URLs must be http(s)', () => {
    expect(validateHubUrl('https://hub.example.com')).toBeUndefined();
    expect(validateHubUrl('ftp://hub.example.com')).toBeDefined();
    expect(validateHubUrl('hub.example.com')).toBeDefined();
  });
});

describe('choices', () => {
  const tools = [
    { tool: 'codex' as const, detected: true, why: 'codex on PATH' },
    { tool: 'claude' as const, detected: false },
    { tool: 'gemini' as const, detected: false },
  ];

  it('marks detected agents and drops excluded ones', () => {
    expect(agentChoices(tools)).toEqual([
      { value: 'codex', label: 'Codex', hint: 'detected · codex on PATH' },
      { value: 'claude', label: 'Claude Code', hint: undefined },
      { value: 'gemini', label: 'Gemini CLI', hint: undefined },
    ]);
    expect(agentChoices(tools, ['codex', 'gemini']).map((c) => c.value)).toEqual(['claude']);
  });

  it('maps hub choices to --hub values', () => {
    expect(hubFlag('public')).toBe(DEFAULT_HUB_URL);
    expect(hubFlag('local')).toBe('local');
    expect(hubFlag('custom', ' https://h.example.com ')).toBe('https://h.example.com');
  });

  it('offers linking only with a GitHub origin and a new repo only outside a repo with gh', () => {
    const vals = (c: ReturnType<typeof repoChoices>) => c.map((x) => x.value);
    expect(vals(repoChoices({ isGit: true, slug: 'me/app', hasGh: true }, 't'))).toEqual(['link', 'local']);
    expect(vals(repoChoices({ isGit: true, slug: null, hasGh: true }, 't'))).toEqual(['local']);
    expect(vals(repoChoices({ isGit: false, slug: null, hasGh: true }, 't'))).toEqual(['new', 'local']);
    expect(vals(repoChoices({ isGit: false, slug: null, hasGh: false }, 't'))).toEqual(['local']);
  });

  it('disables a new repo when the team name is not a valid repo name', () => {
    const [newRepo] = repoChoices({ isGit: false, slug: null, hasGh: true }, 'my team');
    expect(newRepo).toMatchObject({ value: 'new', disabled: true });
    expect(newRepo!.hint).toMatch(/invalid repo name/);
  });
});

describe('answers → command options', () => {
  it('create: link this repo', () => {
    expect(createOptions({ name: 't', agent: 'claude', repo: 'link', hub: DEFAULT_HUB_URL }))
      .toEqual({ agent: 'claude', hub: DEFAULT_HUB_URL, install: true });
  });

  it('create: local only', () => {
    expect(createOptions({ name: 't', agent: 'codex', repo: 'local', hub: 'local' }))
      .toEqual({ agent: 'codex', hub: 'local', install: true, local: true });
  });

  it('create: new GitHub repo with visibility', () => {
    expect(createOptions({ name: 't', agent: 'claude', repo: 'new', visibility: 'public', hub: 'https://h.example.com' }))
      .toEqual({ agent: 'claude', hub: 'https://h.example.com', install: true, newRepo: true, visibility: 'public' });
    expect(createOptions({ name: 't', agent: 'claude', repo: 'new', hub: 'local' }).visibility).toBe('private');
  });

  it('join: trims the code and maps clone', () => {
    expect(joinOptions({ code: ' abcd-efgh-jkmn-pqrs ', agent: 'gemini', hub: 'local', clone: false }))
      .toEqual({ code: 'abcd-efgh-jkmn-pqrs', opts: { agent: 'gemini', hub: 'local', install: true, clone: false } });
  });
});
