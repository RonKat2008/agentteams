import { describe, expect, it } from 'vitest';
import {
  ClaimFilesInput, CreateTeamInput, MemberName, Recipient, SendMessageInput, ActivityQuery, CommitInput,
} from '@agentteams/shared';

describe('MemberName', () => {
  it('lowercases and trims', () => {
    expect(MemberName.parse('  Ronit ')).toBe('ronit');
  });
  it('rejects dashes and spaces', () => {
    expect(MemberName.safeParse('ro-nit').success).toBe(false);
    expect(MemberName.safeParse('ro nit').success).toBe(false);
  });
});

describe('Recipient', () => {
  it('accepts all and agent names', () => {
    expect(Recipient.parse('all')).toBe('all');
    expect(Recipient.parse('Dylan-Claude')).toBe('dylan-claude');
    expect(Recipient.parse('ronit-claude-2')).toBe('ronit-claude-2');
  });
  it('rejects a bare member name', () => {
    expect(Recipient.safeParse('dylan').success).toBe(false);
  });
});

describe('CreateTeamInput', () => {
  it('defaults defaultBranch to main', () => {
    const p = CreateTeamInput.parse({ name: 'squad', member: 'ronit', tool: 'claude', repo: { provider: 'local' } });
    expect(p.repo.defaultBranch).toBe('main');
  });
  it('requires a slug for github repos', () => {
    const r = CreateTeamInput.safeParse({ name: 'squad', member: 'ronit', tool: 'claude', repo: { provider: 'github' } });
    expect(r.success).toBe(false);
  });
});

describe('SendMessageInput', () => {
  it('defaults kind to fyi', () => {
    expect(SendMessageInput.parse({ to: 'all', body: 'hi' }).kind).toBe('fyi');
  });
  it('rejects bodies over 8192 chars', () => {
    expect(SendMessageInput.safeParse({ to: 'all', body: 'x'.repeat(8193) }).success).toBe(false);
  });
});

describe('ClaimFilesInput', () => {
  it('applies defaults', () => {
    expect(ClaimFilesInput.parse({ globs: ['src/**'] })).toEqual({ globs: ['src/**'], exclusive: true, ttlMin: 120 });
  });
  it('rejects absolute and parent-relative globs', () => {
    expect(ClaimFilesInput.safeParse({ globs: ['/etc/passwd'] }).success).toBe(false);
    expect(ClaimFilesInput.safeParse({ globs: ['../other/**'] }).success).toBe(false);
  });
});

describe('ActivityQuery', () => {
  it('coerces limit from a query string', () => {
    expect(ActivityQuery.parse({ limit: '5' }).limit).toBe(5);
  });
});

describe('CommitInput', () => {
  it('rejects a non-hex sha', () => {
    expect(CommitInput.safeParse({ sha: 'zzzzzzz', branch: 'b', message: 'm', files: [], insertions: 0, deletions: 0 }).success).toBe(false);
  });
});
