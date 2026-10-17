import { describe, expect, it } from 'vitest';
import {
  agentChoices, createOptions, joinOptions, repoChoices, teamKindChoices, validateHubTarget, validateHubUrl, validateInviteCode,
  validateTeamName,
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

  it('asks who will be on the team: local first, git (needs a remote), a hub server last', () => {
    const kinds = teamKindChoices();
    expect(kinds.map((k) => k.value)).toEqual(['local', 'git', 'hub']);
    expect(kinds[0]!.label).toBe('Just my agents on this computer');
    expect(kinds[1]).toMatchObject({ disabled: true, hint: 'add a git remote first (e.g. a GitHub repo)' });
    expect(kinds[2]!.label).toBe('A hub server (advanced)');
    const withRemote = teamKindChoices({ remoteUrl: 'https://github.com/me/app.git' });
    expect(withRemote[1]).toMatchObject({ value: 'git', hint: 'https://github.com/me/app.git' });
    expect(withRemote[1]!.disabled).toBeFalsy();
    const withGh = teamKindChoices({ remoteUrl: null, newRepo: true, teamName: 'squad' });
    expect(withGh.map((k) => k.value)).toEqual(['local', 'git', 'newRepo', 'hub']);
    expect(withGh[2]!.label).toContain('./squad');
  });

  it('accepts git invite codes as well as hub codes', () => {
    expect(validateInviteCode('at1-' + 'a'.repeat(120))).toBeUndefined();
    expect(validateInviteCode('at1-short')).toBeDefined();
    expect(validateInviteCode('at1-' + 'A'.repeat(120))).toBeDefined();
  });

  it('a hub server answer is an http(s) URL or "local"', () => {
    expect(validateHubTarget('local')).toBeUndefined();
    expect(validateHubTarget(' LOCAL ')).toBeUndefined();
    expect(validateHubTarget('https://h.example.com')).toBeUndefined();
    expect(validateHubTarget('h.example.com')).toMatch(/or "local"/);
  });

  it('a team on this computer needs a git repo, so "local only" is not offered outside one', () => {
    const vals = (c: ReturnType<typeof repoChoices>) => c.map((x) => x.value);
    expect(vals(repoChoices({ isGit: false, slug: null, hasGh: true, localTeam: true }, 't'))).toEqual(['new']);
    expect(vals(repoChoices({ isGit: false, slug: null, hasGh: false, localTeam: true }, 't'))).toEqual([]);
    expect(vals(repoChoices({ isGit: true, slug: null, hasGh: false, localTeam: true }, 't'))).toEqual(['local']);
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

  it('create/join: no hub means no --hub (a local team)', () => {
    expect(createOptions({ name: 't', agent: 'claude', repo: 'local', as: 'ada' }))
      .toEqual({ agent: 'claude', install: true, local: true, as: 'ada' });
    expect(joinOptions({ code: 'abcd-efgh-jkmn-pqrs', agent: 'codex', clone: false }).opts)
      .toEqual({ agent: 'codex', install: true, clone: false });
  });

  it('join: trims the code and maps clone', () => {
    expect(joinOptions({ code: ' abcd-efgh-jkmn-pqrs ', agent: 'gemini', hub: 'local', clone: false }))
      .toEqual({ code: 'abcd-efgh-jkmn-pqrs', opts: { agent: 'gemini', hub: 'local', install: true, clone: false } });
  });
});
