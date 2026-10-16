import { HOOK_EVENT_NAMES } from '../hookEvents.js';
import type { HookDialect } from './types.js';

export const readStringCwd = (input: Record<string, unknown>): string | undefined =>
  typeof input.cwd === 'string' ? input.cwd : undefined;

/** `stop_hook_active === true` (claude/droid/gemini style) or `loop_count > 0` (cursor style). */
export const isCommonStopLoop = (input: Record<string, unknown>): boolean =>
  input.stop_hook_active === true || (typeof input.loop_count === 'number' && input.loop_count > 0);

/** Claude Code contract; Codex and the placeholder adapters use it too. */
export const claudeDialect: HookDialect = {
  render(outcome) {
    if (outcome.type === 'context') {
      return {
        stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_EVENT_NAMES[outcome.event], additionalContext: outcome.text } }),
        exitCode: 0,
      };
    }
    if (outcome.type === 'block') return { stdout: JSON.stringify({ decision: 'block', reason: outcome.text }), exitCode: 0 };
    return { stdout: '', exitCode: 0 };
  },
  readCwd: readStringCwd,
  isStopLoop: isCommonStopLoop,
};

export const codexDialect: HookDialect = { ...claudeDialect };
