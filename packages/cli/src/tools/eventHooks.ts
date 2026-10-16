import type { ToolKind } from '@agentteams/shared';
import { HOOK_EVENTS, type HookEvent } from '../hookEvents.js';
import { hookCommand, isManagedHookCommand } from '../install/hooksConfig.js';

export interface EventHandler { type: string; command: string; timeout?: number; [k: string]: unknown }
export interface EventGroup { matcher?: string; hooks: EventHandler[]; [k: string]: unknown }

/**
 * Pure: returns a copy of an event-keyed hooks map ({ NativeEvent: [group] }) with exactly one managed handler per
 * neutral event; user groups and handlers are untouched. A non-array value under a native name is user-owned and kept.
 */
export function mergeEventHooks(
  existing: Record<string, unknown>,
  names: Record<HookEvent, string>,
  cli: string,
  tool: ToolKind,
  timeout: number,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const event of HOOK_EVENTS) {
    const name = names[event];
    const current = next[name];
    if (current !== undefined && !Array.isArray(current)) continue;
    const kept = ((current ?? []) as EventGroup[])
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isManagedHookCommand(h?.command)) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    kept.push({ hooks: [{ type: 'command', command: hookCommand(cli, event, tool), timeout }] });
    next[name] = kept;
  }
  return next;
}
