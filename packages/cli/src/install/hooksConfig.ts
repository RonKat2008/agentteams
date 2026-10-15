import type { ToolKind } from '@agentteams/shared';
import { HOOK_EVENTS, HOOK_EVENT_NAMES } from '../hooks.js';

export interface HookHandler { type: string; command: string; timeout?: number }
export interface HookGroup { matcher?: string; hooks: HookHandler[] }
export interface HooksJson { hooks?: Record<string, HookGroup[]>; [k: string]: unknown }

export const HOOK_TIMEOUT_SECONDS = 10;

export function isManagedHookCommand(cmd: string): boolean {
  return cmd.includes(' hook ') && cmd.includes(' --tool ') && cmd.includes('agentteams');
}

/** Pure: returns a new config with exactly one managed handler per event; user hooks untouched. */
export function mergeManagedHooks(config: HooksJson, cli: string, tool: ToolKind): HooksJson {
  const next = structuredClone(config);
  const hooks: Record<string, HookGroup[]> = next.hooks ?? {};
  for (const event of HOOK_EVENTS) {
    const name = HOOK_EVENT_NAMES[event];
    const kept = (hooks[name] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isManagedHookCommand(h.command)) }))
      .filter((g) => g.hooks.length > 0);
    kept.push({
      matcher: '',
      hooks: [{ type: 'command', command: `${cli} hook ${event} --tool ${tool}`, timeout: HOOK_TIMEOUT_SECONDS }],
    });
    hooks[name] = kept;
  }
  next.hooks = hooks;
  return next;
}
