/**
 * Lean entry for in-process transports: services, context, SQLite and the MCP server builder.
 * Deliberately does NOT import hono, @hono/node-server, pg or the HTTP app, so CLI hooks stay fast.
 */
export { createContext, withTx, type Actor, type HubContext } from './context.js';
export { createSqliteDb } from './db/sqlite.js';
export { migrateToLatest } from './db/migrations.js';
export type { Database } from './db/schema.js';
export type { ControlledTransaction, Kysely } from 'kysely';
export { DomainError, type ErrorCode } from './errors.js';
export { buildMcpServer } from './mcp/server.js';
export { getActivity } from './services/activity.js';
export { checkFiles, claimFiles, recordClaimOverride, releaseFiles, whoOwns } from './services/claims.js';
export { getChanges, recordCommit } from './services/commits.js';
export { markRead, readInbox, sendMessage } from './services/messages.js';
export { createReplicatedTeam, registerReplicatedAgent } from './services/replication.js';
export {
  assignTask, claimTask, completeTask, createTask, getTaskView, listTasks, markMerged, updateTask,
} from './services/tasks.js';
export {
  authenticate, createTeam, getTeamStatus, joinTeam, previewInvite, revokeInvite, rotateInvite, setOrchestrator,
} from './services/teams.js';
