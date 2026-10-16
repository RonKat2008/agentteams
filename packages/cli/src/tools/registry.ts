import { ToolKind } from '@agentteams/shared';
import { claudeAdapter } from './claude.js';
import { clineAdapter } from './cline.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';
import { droidAdapter } from './droid.js';
import { geminiAdapter } from './gemini.js';
import { opencodeAdapter } from './opencode.js';
import { otherAdapter } from './other.js';
import { rooAdapter } from './roo.js';
import { cursorAdapter } from './cursor.js';
import { windsurfAdapter } from './windsurf.js';
import type { ToolAdapter } from './types.js';

/** One entry per ToolKind (the type forces completeness). */
const ADAPTERS: Record<ToolKind, ToolAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  gemini: geminiAdapter,
  copilot: copilotAdapter,
  droid: droidAdapter,
  opencode: opencodeAdapter,
  windsurf: windsurfAdapter,
  cline: clineAdapter,
  roo: rooAdapter,
  other: otherAdapter,
};

export const getAdapter = (kind: ToolKind): ToolAdapter => ADAPTERS[kind];
export const allAdapters = (): ToolAdapter[] => ToolKind.options.map((k) => ADAPTERS[k]);

/** claude, codex, then the rest in ToolKind order (used for deterministic credential fallback). */
export const orderedToolKinds = (): ToolKind[] => [
  'claude', 'codex', ...ToolKind.options.filter((k) => k !== 'claude' && k !== 'codex'),
];
