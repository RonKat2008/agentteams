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

/**
 * Every op this replica has evaluated. Part of the replicated view (identical on every replica).
 * Identity is (agent, op_id); `hash` (sha256 of the canonical op JSON) separates equivocating variants.
 */
export interface AppliedOpsTable {
  agent: string;
  op_id: string;
  hash: string;
  /** HLC time; null for malformed envelopes and equivocation losers (they take no part in the total order). */
  ts: string | null;
  status: 'applied' | 'rejected';
  /** A stable code (DomainError code or a fixed category), never free text. */
  error: string | null;
}

/** Local key/value state of this replica; never wiped by a rebuild, never replicated. */
export interface ReplicaStateTable {
  key: string;
  value: string;
}

/** Local-only notices for this replica's own agent (e.g. "your op was rejected"); survive rebuilds. */
export interface ReplicaNoticesTable {
  agent_id: string;
  op_id: string;
  body: string;
  created_at: string;
  delivered_at: string | null;
}

/** Local trust-on-first-use pins of agent signing keys; never wiped, never replaced. */
export interface ReplicaPendingTable {
  agent_id: string;
  op_id: string;
  ts: string;
  op_json: string;
  created_at: string;
}

export interface AgentKeyPinsTable {
  agent_id: string;
  public_key: string;
  pinned_at: string;
}

/** Local trust-on-first-use pin of a team's meta (creator id and key); never wiped, never replaced. */
export interface TeamMetaPinsTable {
  team_id: string;
  meta_json: string;
  pinned_at: string;
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
  agent_key_pins: AgentKeyPinsTable;
  team_meta_pins: TeamMetaPinsTable;
  replica_pending: ReplicaPendingTable;
}

export type TeamRow = Selectable<TeamsTable>;
