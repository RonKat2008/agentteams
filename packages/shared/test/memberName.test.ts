import { describe, expect, it } from 'vitest';
import { MemberName, pickMemberName, ToolKind } from '@agentteams/shared';

describe('pickMemberName', () => {
  it('takes the first usable candidate, slugified', () => {
    expect(pickMemberName(['Ronit K', 'other'])).toBe('ronit_k');
  });
  it.each(['root', 'user', 'codex', 'Cursor', 'claude', 'gemini', 'admin', 'me', 'ubuntu', '', '!!!', '  '])(
    'skips the generic or empty candidate %j',
    (bad) => {
      expect(pickMemberName([bad, 'ana'])).toBe('ana');
    },
  );
  it('falls back to "me" when nothing is usable', () => {
    expect(pickMemberName(['root', 'codex', ''])).toBe('me');
    expect(pickMemberName([])).toBe('me');
  });
  it('never yields a tool name, so agent names cannot be <tool>-<tool>', () => {
    for (const tool of ToolKind.options) expect(pickMemberName([tool])).toBe('me');
  });
  it('truncates to the member name limit into a valid MemberName', () => {
    const name = pickMemberName(['a.very-long.user.name.exceeding.limit']);
    expect(name).toBe('a_very_long_user_name_ex');
    expect(MemberName.safeParse(name).success).toBe(true);
  });
});
