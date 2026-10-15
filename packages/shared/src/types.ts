import type { ActivityType, MessageKind, PresenceStatus, RepoLink, TaskStatus, ToolKind } from './schemas.js';

export interface AgentView {
  name: string;
  member: string;
  tool: ToolKind;
  presence: PresenceStatus;
  lastSeenAt: string | null;
  isOrchestrator: boolean;
  currentTask: { number: number; title: string; status: TaskStatus } | null;
  claims: string[];
}

export interface TeamStatus {
  team: { name: string; repo: RepoLink; orchestrator: string | null };
  agents: AgentView[];
}

export interface InboxMessage {
  id: string;
  from: string;
  fromRole: 'orchestrator' | 'peer';
  to: string; // recipient agent name or "all"
  kind: MessageKind;
  body: string;
  createdAt: string;
}

export interface TaskView {
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: string | null;
  branch: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimView {
  agent: string;
  glob: string;
  exclusive: boolean;
  expiresAt: string;
}

export interface ClaimResult {
  granted: boolean;
  claims: ClaimView[];
  conflicts: ClaimView[];
}

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  agent: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface CommitView {
  sha: string;
  branch: string;
  agent: string;
  message: string;
  files: string[];
  insertions: number;
  deletions: number;
  createdAt: string;
}
