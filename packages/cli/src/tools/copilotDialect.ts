import { HOOK_EVENT_NAMES, type HookEvent } from '../hookEvents.js';
import { isCommonStopLoop, readStringCwd } from './dialects.js';
import type { HookDialect } from './types.js';

/**
 * One output that satisfies both Copilot CLI and VS Code agent mode (they share `.github/hooks/*.json`).
 * Copilot CLI reads top-level `additionalContext` / `decision` + `reason`; VS Code reads `hookSpecificOutput`.
 * Each side ignores the other's fields, so both are emitted.
 */
/**
 * Copilot CLI drops command-hook output for userPromptSubmitted and VS Code documents no additionalContext there,
 * so user-prompt-submit is not a context event (consuming there would lose messages).
 */
export const COPILOT_CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>(['session-start', 'post-tool-use']);

export const copilotDialect: HookDialect = {
  contextEvents: COPILOT_CONTEXT_EVENTS,
  render(outcome) {
    if (outcome.type === 'context' && COPILOT_CONTEXT_EVENTS.has(outcome.event)) {
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
