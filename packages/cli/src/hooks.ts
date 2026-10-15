import type { ToolKind } from '@agentteams/shared';
import { resolveCredential } from './credentials.js';
import type { CliDeps } from './deps.js';
import type { InboxMessage } from '@agentteams/shared';
import { fitMessages, formatMessages, formatStatus } from './format.js';
import { HubClient } from './hubClient.js';

export type HookEvent = 'session-start' | 'user-prompt-submit' | 'post-tool-use' | 'stop';
export const HOOK_EVENTS: readonly HookEvent[] = ['session-start', 'user-prompt-submit', 'post-tool-use', 'stop'];
export const HOOK_EVENT_NAMES: Record<HookEvent, string> = {
  'session-start': 'SessionStart',
  'user-prompt-submit': 'UserPromptSubmit',
  'post-tool-use': 'PostToolUse',
  stop: 'Stop',
};

export interface HookResult { stdout: string; exitCode: 0 }

const HOOK_TIMEOUT_MS = 2000;
const EMPTY: HookResult = { stdout: '', exitCode: 0 };

function parseInput(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const contextOutput = (event: HookEvent, additionalContext: string): HookResult => ({
  stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_EVENT_NAMES[event], additionalContext } }),
  exitCode: 0,
});

/** Messages that fit the caps from an unread peek; null when nothing fits. */
async function consumeFitting(client: HubClient, peeked: InboxMessage[]): Promise<{ messages: InboxMessage[]; more: number } | null> {
  const fit = fitMessages(peeked);
  if (fit.length === 0) return null;
  // Mark read only the messages that are actually injected; the rest stay unread.
  const { messages } = await client.ping(true, fit.length);
  return { messages, more: peeked.length - fit.length };
}

const isRealCommand = (m: InboxMessage): boolean => m.kind === 'command' && m.body.trim() !== '';

export async function runHook(
  event: HookEvent,
  stdinText: string,
  tool: ToolKind,
  deps: Pick<CliDeps, 'env' | 'homedir' | 'cwd' | 'fetch'>,
): Promise<HookResult> {
  try {
    const input = parseInput(stdinText);
    const cwd = typeof input.cwd === 'string' ? input.cwd : deps.cwd;
    const cred = await resolveCredential(deps, cwd, tool);
    if (!cred) return EMPTY;
    const client = new HubClient(cred.hubUrl, { apiKey: cred.apiKey, timeoutMs: HOOK_TIMEOUT_MS, fetch: deps.fetch });

    if (event === 'session-start') {
      const status = await client.status();
      const taken = await consumeFitting(client, (await client.ping(false)).messages);
      const text = formatStatus(status, cred.agentName) + (taken ? `\n\n${formatMessages(taken.messages, taken.more)}` : '');
      return contextOutput(event, text);
    }
    if (event === 'stop') {
      if (input.stop_hook_active === true) return EMPTY;
      const peeked = (await client.ping(false)).messages;
      if (!fitMessages(peeked).some(isRealCommand)) return EMPTY;
      const taken = await consumeFitting(client, peeked);
      if (!taken?.messages.some(isRealCommand)) return EMPTY;
      return { stdout: JSON.stringify({ decision: 'block', reason: formatMessages(taken.messages, taken.more) }), exitCode: 0 };
    }
    const taken = await consumeFitting(client, (await client.ping(false)).messages);
    if (!taken || taken.messages.length === 0) return EMPTY;
    return contextOutput(event, formatMessages(taken.messages, taken.more));
  } catch {
    return EMPTY;
  }
}
