export type HookEvent = 'session-start' | 'user-prompt-submit' | 'post-tool-use' | 'stop';
export const HOOK_EVENTS: readonly HookEvent[] = ['session-start', 'user-prompt-submit', 'post-tool-use', 'stop'];
/** Claude-style native names; other tools map the neutral events onto their own names in their adapters. */
export const HOOK_EVENT_NAMES: Record<HookEvent, string> = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
  'post-tool-use': 'PostToolUse',
  stop: 'Stop',
};
