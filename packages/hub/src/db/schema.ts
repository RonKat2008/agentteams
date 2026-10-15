import type { Selectable } from 'kysely';
import type { ActivityType, MessageKind, TaskStatus, ToolKind } from '@agentteams/shared';

export interface TeamsTable {
  id: string;
  name: string;
  invite_code_hash: string;
  invite_expires_at: string;
  invite_revoked: number; // 0 | 1
  repo_provider: 'github' | 'local';
  repo_slug: string | null;
  default_branch: string;
  orchestrator_agent_id: string | null;
  created_by_member: string;
  creator_agent_id: string;
  created_at: string;
}

export interface AgentsTable {
  id: string;
  team_id: string;
  name: string;
  member: string;
  tool: ToolKind;
  api_key_hash: string;
  last_seen_at: string | null;
  created_at: string;
}

export interface MessagesTable {
  id: string;
  team_id: string;
  from_agent_id: string;
  to_agent_id: string | null; // null = broadcast to all
  from_role: 'orchestrator' | 'peer'; // frozen at send time
  kind: MessageKind;
  body: string;
  created_at: string;
}

export interface MessageReadsTable {
  message_id: string;
  agent_id: string;
  read_at: string;
}

export interface TasksTable {
  id: string;
  team_id: string;
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  assignee_agent_id: string | null;
  branch: string | null;
  summary: string | null;
  created_by_agent_id: string;
  created_at: string;
  updated_at: string;
}

export interface ClaimsTable {
  id: string;
  team_id: string;
  agent_id: string;
  glob: string;
  exclusive: number; // 0 | 1
  expires_at: string;
  created_at: string;
}

export interface CommitsTable {
  id: string;
  team_id: string;
  agent_id: string;
  sha: string;
  branch: string;
  message: string;
  files_json: string;
  insertions: number;
  deletions: number;
  created_at: string;
}

export interface ActivityTable {
  id: string;
  team_id: string;
  agent_id: string | null;
  type: ActivityType;
  data_json: string;
  created_at: string;
}

export interface Database {
  teams: TeamsTable;
  agents: AgentsTable;
  messages: MessagesTable;
  message_reads: MessageReadsTable;
  tasks: TasksTable;
  claims: ClaimsTable;
  commits: CommitsTable;
  activity: ActivityTable;
}

export type TeamRow = Selectable<TeamsTable>;
