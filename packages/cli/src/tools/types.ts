import type { ToolKind } from '@agentteams/shared';
import type { Credential } from '../credentials.js';
import type { CliDeps } from '../deps.js';
import type { HookEvent } from '../hookEvents.js';

export interface InstallReport { tool: ToolKind; done: string[]; warnings: string[] }

/** What a hook wants to say, independent of any agent's wire format. */
export type HookOutcome =
  | { type: 'none' }
  | { type: 'context'; event: HookEvent; text: string }
  | { type: 'block'; text: string };

export interface HookRendered { stdout: string; exitCode: 0 }

/** Translates between one agent's hook stdin/stdout contract and the neutral outcome. */
export interface HookDialect {
  render(outcome: HookOutcome, input: Record<string, unknown>): HookRendered;
  /** Working directory of the agent session, from the hook stdin (undefined: use the process cwd). */
  readCwd(input: Record<string, unknown>): string | undefined;
  /** True when this stop hook is itself the result of a previous stop-block (never block twice). */
  isStopLoop(input: Record<string, unknown>): boolean;
  /**
   * Context events whose output the agent actually delivers to the model (undefined: all of them). For any other
   * context event the hook only sends a heartbeat and never marks messages read, so nothing is lost.
   */
  contextEvents?: ReadonlySet<HookEvent>;
}

export interface ToolAdapter {
  kind: ToolKind;
  /** Human name, e.g. "Cursor". */
  label: string;
  /** full: MCP + context hooks; mcp: MCP + rules only. */
  tier: 'full' | 'mcp';
  install(deps: CliDeps, cred: Credential): Promise<InstallReport>;
  installForWorktree?(deps: CliDeps, cred: Credential, worktreePath: string): Promise<InstallReport>;
  dialect: HookDialect;
}
