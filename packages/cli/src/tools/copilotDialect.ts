import { HOOK_EVENT_NAMES } from '../hookEvents.js';
import { isCommonStopLoop, readStringCwd } from './dialects.js';
import type { HookDialect } from './types.js';

/**
 * One output that satisfies both Copilot CLI and VS Code agent mode (they share `.github/hooks/*.json`).
 * Copilot CLI reads top-level `additionalContext` / `decision` + `reason`; VS Code reads `hookSpecificOutput`.
 * Each side ignores the other's fields, so both are emitted.
 */
export const copilotDialect: HookDialect = {
  render(outcome) {
    if (outcome.type === 'context') {
      const hookEventName = HOOK_EVENT_NAMES[outcome.event];
      return {
        stdout: JSON.stringify({
          additionalContext: outcome.text,
          hookSpecificOutput: { hookEventName, additionalContext: outcome.text },
        }),
        exitCode: 0,
      };
    }
    if (outcome.type === 'block') {
      return {
        stdout: JSON.stringify({
          decision: 'block',
          reason: outcome.text,
          hookSpecificOutput: { hookEventName: 'Stop', decision: 'block', reason: outcome.text },
        }),
        exitCode: 0,
      };
    }
    return { stdout: '', exitCode: 0 };
  },
  readCwd: readStringCwd,
  isStopLoop: isCommonStopLoop,
};
