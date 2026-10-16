import { installClaude, installClaudeForWorktree } from '../install/claude.js';
import { claudeDialect } from './dialects.js';
import type { ToolAdapter } from './types.js';

export const claudeAdapter: ToolAdapter = {
  kind: 'claude',
  label: 'Claude Code',
  tier: 'full',
  launch: 'claude',
  dialect: claudeDialect,
  install: (deps, cred) => installClaude(deps, cred),
  installForWorktree: (deps, cred, worktreePath) => installClaudeForWorktree(deps, cred, worktreePath),
};
