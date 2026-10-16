import type { ToolKind } from '@agentteams/shared';
import { resolveCredentialForCwd, type Credential } from './credentials.js';
import { takeSyncWarning } from './git/syncState.js';
import type { CliDeps } from './deps.js';
import type { InboxMessage } from '@agentteams/shared';
import { fitMessages, formatMessages, formatStatus } from './format.js';
import { HOOK_EVENTS, HOOK_EVENT_NAMES, type HookEvent } from './hookEvents.js';
import { teamClientFor, type TeamClient } from './teamClient.js';
import { getAdapter } from './tools/registry.js';
import type { HookOutcome } from './tools/types.js';

export { HOOK_EVENTS, HOOK_EVENT_NAMES, type HookEvent };

export interface HookResult { stdout: string; exitCode: 0 }

const HOOK_TIMEOUT_MS = 2000;
const NONE: HookOutcome = { type: 'none' };

function parseInput(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Messages that fit the caps from an unread peek; null when nothing fits. */
async function consumeFitting(client: TeamClient, peeked: InboxMessage[]): Promise<{ messages: InboxMessage[]; more: number } | null> {
  const fit = fitMessages(peeked);
  if (fit.length === 0) return null;
  // Mark read only the messages that are actually injected; the rest stay unread.
  const { messages } = await client.ping(true, fit.length);
  return { messages, more: peeked.length - fit.length };
}

const isRealCommand = (m: InboxMessage): boolean => m.kind === 'command' && m.body.trim() !== '';

/** Computes what the hook should say, independent of the agent's wire format. */
async function computeOutcome(
  event: HookEvent,
  tool: ToolKind,
  input: Record<string, unknown>,
  cwd: string,
  deps: Pick<CliDeps, 'env' | 'homedir' | 'cwd' | 'fetch' | 'exec'>,
): Promise<HookOutcome> {
  const cred = await resolveCredentialForCwd(deps, cwd, tool);
  if (!cred) return NONE;
  const outcome = await teamOutcome(event, tool, input, cred, deps);
  return cred.transport === 'git' ? withSyncWarning(outcome, event, tool, cred, deps) : outcome;
}

/**
 * Git teams: the last failed background sync is reported once, as one line in the next hook output that the
 * agent will actually see. Never blocks or throws.
 */
async function withSyncWarning(
  outcome: HookOutcome, event: HookEvent, tool: ToolKind, cred: Credential, deps: Pick<CliDeps, 'exec'>,
): Promise<HookOutcome> {
  const delivers = getAdapter(tool).dialect.contextEvents;
  const visible = outcome.type !== 'none' || (event !== 'stop' && (!delivers || delivers.has(event)));
  if (!visible) return outcome;
  const warning = await takeSyncWarning(deps, cred.repoPath).catch(() => null);
  if (!warning) return outcome;
  if (outcome.type === 'none') return { type: 'context', event, text: warning };
  return { ...outcome, text: `${warning}\n\n${outcome.text}` } as HookOutcome;
}

async function teamOutcome(
  event: HookEvent,
  tool: ToolKind,
  input: Record<string, unknown>,
  cred: Credential,
  deps: Pick<CliDeps, 'env' | 'homedir' | 'cwd' | 'fetch' | 'exec'>,
): Promise<HookOutcome> {
  const stopLoop = getAdapter(tool).dialect.isStopLoop(input);
  const client = teamClientFor(deps, cred, { timeoutMs: HOOK_TIMEOUT_MS });
  const delivers = getAdapter(tool).dialect.contextEvents;
  if (event !== 'stop' && delivers && !delivers.has(event)) {
    // The agent would discard our output: heartbeat only, never consume.
    await client.ping(false);
    return NONE;
  }

  if (event === 'session-start') {
    const status = await client.status();
    const taken = await consumeFitting(client, (await client.ping(false)).messages);
    const text = formatStatus(status, cred.agentName) + (taken ? `\n\n${formatMessages(taken.messages, taken.more)}` : '');
    return { type: 'context', event, text };
  }
  if (event === 'stop') {
    if (stopLoop) return NONE;
    const peeked = (await client.ping(false)).messages;
    if (!fitMessages(peeked).some(isRealCommand)) return NONE;
    const taken = await consumeFitting(client, peeked);
    if (!taken?.messages.some(isRealCommand)) return NONE;
    return { type: 'block', text: formatMessages(taken.messages, taken.more) };
  }
  const taken = await consumeFitting(client, (await client.ping(false)).messages);
  if (!taken || taken.messages.length === 0) return NONE;
  return { type: 'context', event, text: formatMessages(taken.messages, taken.more) };
}

export async function runHook(
  event: HookEvent,
  stdinText: string,
  tool: ToolKind,
  deps: Pick<CliDeps, 'env' | 'homedir' | 'cwd' | 'fetch' | 'exec'>,
): Promise<HookResult> {
  try {
    const input = parseInput(stdinText);
    const dialect = getAdapter(tool).dialect;
    const outcome = await computeOutcome(event, tool, input, dialect.readCwd(input) ?? deps.cwd, deps);
    return dialect.render(outcome, input);
  } catch {
    return { stdout: '', exitCode: 0 };
  }
}
