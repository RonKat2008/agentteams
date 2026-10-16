import type { ToolKind } from '@agentteams/shared';
import { claudeDialect } from './dialects.js';
import type { ToolAdapter } from './types.js';

/** Stand-in for tools whose installer has not landed yet. A real adapter file replaces its registry line. */
export function placeholderAdapter(kind: ToolKind, label: string): ToolAdapter {
  return {
    kind,
    label,
    tier: 'mcp',
    dialect: claudeDialect,
    async install() {
      return { tool: kind, done: [], warnings: [`no installer for tool "${kind}" yet`] };
    },
  };
}

export const geminiPlaceholder = placeholderAdapter('gemini', 'Gemini CLI');
export const copilotPlaceholder = placeholderAdapter('copilot', 'GitHub Copilot');
export const droidPlaceholder = placeholderAdapter('droid', 'Factory Droid');
export const opencodePlaceholder = placeholderAdapter('opencode', 'OpenCode');
export const clinePlaceholder = placeholderAdapter('cline', 'Cline');
export const rooPlaceholder = placeholderAdapter('roo', 'Roo Code');
export const otherPlaceholder = placeholderAdapter('other', 'Other');
