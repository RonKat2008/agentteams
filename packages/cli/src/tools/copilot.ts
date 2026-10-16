import { installCopilot, installCopilotForWorktree } from '../install/copilot.js';
import { copilotDialect } from './copilotDialect.js';
import type { ToolAdapter } from './types.js';

export const copilotAdapter: ToolAdapter = {
  kind: 'copilot',
  label: 'GitHub Copilot',
  tier: 'full',
  dialect: copilotDialect,
  install: (deps, cred) => installCopilot(deps, cred),
  installForWorktree: (deps, cred, worktreePath) => installCopilotForWorktree(deps, cred, worktreePath),
};
