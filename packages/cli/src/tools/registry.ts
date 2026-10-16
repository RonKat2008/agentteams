import { ToolKind } from '@agentteams/shared';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';
import { droidAdapter } from './droid.js';
import { geminiAdapter } from './gemini.js';
import { clinePlaceholder } from './placeholders.js';
import { cursorPlaceholder } from './placeholders.js';
import { opencodePlaceholder } from './placeholders.js';
import { otherPlaceholder } from './placeholders.js';
import { rooPlaceholder } from './placeholders.js';
import { windsurfPlaceholder } from './placeholders.js';
import type { ToolAdapter } from './types.js';

/** One entry per ToolKind (the type forces completeness). A tool's task replaces only its own line. */
const ADAPTERS: Record<ToolKind, ToolAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorPlaceholder,
  gemini: geminiAdapter,
  copilot: copilotAdapter,
  droid: droidAdapter,
  opencode: opencodePlaceholder,
  windsurf: windsurfPlaceholder,
  cline: clinePlaceholder,
  roo: rooPlaceholder,
  other: otherPlaceholder,
};

export const getAdapter = (kind: ToolKind): ToolAdapter => ADAPTERS[kind];
export const allAdapters = (): ToolAdapter[] => ToolKind.options.map((k) => ADAPTERS[k]);

/** claude, codex, then the rest in ToolKind order (used for deterministic credential fallback). */
export const orderedToolKinds = (): ToolKind[] => [
  'claude', 'codex', ...ToolKind.options.filter((k) => k !== 'claude' && k !== 'codex'),
];
