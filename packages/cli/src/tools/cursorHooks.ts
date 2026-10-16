import type { ToolKind } from '@agentteams/shared';
import type { HookEvent } from '../hookEvents.js';
import { hookCommand, isManagedHookCommand, HOOK_TIMEOUT_SECONDS } from '../install/hooksConfig.js';
import { InvalidConfigShape, isPlainObject as isObj, type JsonConfig } from './jsonConfig.js';

/**
 * Cursor native event -> neutral event. beforeSubmitPrompt is deliberately absent: Cursor ignores any context
 * returned from it, so wiring it would mark inbox messages read without ever delivering them.
 */
export const CURSOR_EVENTS: ReadonlyArray<readonly [string, HookEvent]> = [
  ['sessionStart', 'session-start'],
  ['postToolUse', 'post-tool-use'],
  ['stop', 'stop'],
];

/** Pure: exactly one managed handler per event in a Cursor hooks.json (version 1); user hooks untouched. */
export function mergeCursorHooks(config: JsonConfig, cli: string, tool: ToolKind): JsonConfig {
  const next = structuredClone(config);
  if (next.hooks !== undefined && !isObj(next.hooks)) throw new InvalidConfigShape('"hooks" is not an object');
  const hooks: Record<string, unknown> = isObj(next.hooks) ? next.hooks : {};
  for (const [native, event] of CURSOR_EVENTS) {
    const current = hooks[native];
    if (current !== undefined && !Array.isArray(current)) throw new InvalidConfigShape(`"hooks.${native}" is not an array`);
    const kept = ((current ?? []) as unknown[]).filter((h) => !(isObj(h) && isManagedHookCommand(h.command)));
    kept.push({ command: hookCommand(cli, event, tool), timeout: HOOK_TIMEOUT_SECONDS });
    hooks[native] = kept;
  }
  return { version: 1, ...next, hooks };
}
