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
  github_login: string | null;
  github_id: number | null;
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
  merged_at: string | null;
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

// ---- Replication bookkeeping (git transport). Unused by the HTTP hub. ----

/** Registered agent signing keys; first registration wins. Part of the replicated view. */
export interface AgentKeysTable {
  agent_id: string;
  team_id: string;
  public_key: string;
  registered_op_id: string;
}

/** Every op this replica has evaluated. Part of the replicated view (identical on every replica). */
export interface AppliedOpsTable {
  op_id: string;
  /** HLC time; null when the op's envelope was malformed (such ops take no part in the total order). */
  ts: string | null;
  agent: string | null;
  status: 'applied' | 'rejected';
  error: string | null;
  /** sha256 of the canonical op JSON; a different op reusing an id forces a rebuild. */
  hash: string;
}

/** Local key/value state of this replica; never wiped by a rebuild, never replicated. */
export interface ReplicaStateTable {
  key: string;
  value: string;
}

/** Local-only notices for this replica's own agent (e.g. "your op was rejected"); survive rebuilds. */
export interface ReplicaNoticesTable {
  op_id: string;
  agent_id: string;
  body: string;
  created_at: string;
  delivered_at: string | null;
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
  agent_keys: AgentKeysTable;
  applied_ops: AppliedOpsTable;
  replica_state: ReplicaStateTable;
  replica_notices: ReplicaNoticesTable;
}

export type TeamRow = Selectable<TeamsTable>;
