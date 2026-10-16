import { installCodex } from '../install/codex.js';
import { codexDialect } from './dialects.js';
import type { ToolAdapter } from './types.js';

export const codexAdapter: ToolAdapter = {
  kind: 'codex',
  label: 'Codex',
  tier: 'full',
  launch: 'codex',
  dialect: codexDialect,
  install: (deps, cred) => installCodex(deps, cred),
};
