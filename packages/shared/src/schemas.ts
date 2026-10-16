import { z } from 'zod';
import { DEFAULT_CLAIM_TTL_MIN, MAX_MESSAGE_LENGTH } from './constants.js';

/** Control characters and Unicode line/paragraph separators: never allowed in single-line fields. */
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/u;
const singleLine = (s: string): boolean => !CONTROL_CHARS.test(s);
const SINGLE_LINE_MESSAGE = 'must not contain control characters or line breaks';
/** Names end up in injected agent context and committed files, so also keep markup out. */
const noMarkup = (s: string): boolean => !/[<>]/.test(s);

export const ToolKind = z.enum(['claude', 'codex', 'cursor', 'gemini', 'copilot', 'droid', 'opencode', 'windsurf', 'cline', 'roo', 'other']);
export type ToolKind = z.infer<typeof ToolKind>;

export const MessageKind = z.enum(['command', 'question', 'fyi']);
export type MessageKind = z.infer<typeof MessageKind>;

export const TaskStatus = z.enum(['open', 'assigned', 'in_progress', 'blocked', 'done']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const PresenceStatus = z.enum(['active', 'idle', 'offline']);
export type PresenceStatus = z.infer<typeof PresenceStatus>;

export const ActivityType = z.enum([
  'team_created', 'agent_joined', 'orchestrator_changed', 'invite_rotated', 'invite_revoked',
  'task_created', 'task_assigned', 'task_claimed', 'task_updated', 'task_completed',
  'files_claimed', 'files_released', 'commit', 'message_sent', 'merged', 'claim_overridden',
]);
export type ActivityType = z.infer<typeof ActivityType>;

export const MemberName = z
  .string().trim().toLowerCase()
  .regex(/^[a-z0-9_]{1,24}$/, 'member name must be 1-24 characters of a-z, 0-9 or _');
export type MemberName = z.infer<typeof MemberName>;

export const MEMBER_NAME_MAX = 24;

/** The one rule for turning a username (e.g. a GitHub login) into a valid member name. */
export function defaultMemberName(username: string): string {
  const cleaned = username.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, MEMBER_NAME_MAX);
  return cleaned || 'user';
}

export const AgentName = z
  .string().trim().toLowerCase()
  .regex(/^[a-z0-9_]{1,24}-[a-z0-9-]{1,30}$/, 'agent names look like <member>-<tool>, e.g. ronit-claude');
export type AgentName = z.infer<typeof AgentName>;

export const Recipient = z.union([z.literal('all'), AgentName]);
export type Recipient = z.infer<typeof Recipient>;

export const RepoLink = z
  .object({
    provider: z.enum(['github', 'local']),
    slug: z
      .string()
      .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'slug must look like owner/name')
      .refine((v) => !v.startsWith('-') && !v.endsWith('/.') && !v.endsWith('/..'), 'slug must look like owner/name')
      .optional(),
    defaultBranch: z.string().min(1).max(255).refine(singleLine, `default branch ${SINGLE_LINE_MESSAGE}`).default('main'),
  })
  .refine((r) => r.provider === 'local' || r.slug !== undefined, {
    message: 'github repos need a slug like owner/name',
    path: ['slug'],
  });
export type RepoLink = z.output<typeof RepoLink>;

/** Validated by the hub only in hosted mode; local mode must ignore whatever a client sends. */
const GithubToken = z.unknown();

export const CreateTeamInput = z.object({
  name: z.string().trim().min(1).max(64)
    .refine(singleLine, `team name ${SINGLE_LINE_MESSAGE}`)
    .refine(noMarkup, 'team name must not contain < or >'),
  member: MemberName.optional(), // required in local mode; ignored in hosted mode (derived from GitHub)
  tool: ToolKind,
  repo: RepoLink,
  githubToken: GithubToken.optional(),
});
export type CreateTeamInput = z.input<typeof CreateTeamInput>;

const InviteCode = z.string().trim().min(1).max(64);

export const JoinTeamInput = z.object({
  inviteCode: InviteCode,
  member: MemberName.optional(), // required in local mode; ignored in hosted mode (derived from GitHub)
  tool: ToolKind,
  githubToken: GithubToken.optional(),
});
export type JoinTeamInput = z.input<typeof JoinTeamInput>;

export const InvitePreviewInput = z.object({ inviteCode: InviteCode });
export type InvitePreviewInput = z.input<typeof InvitePreviewInput>;

export const SetOrchestratorInput = z.object({ agent: AgentName });
export type SetOrchestratorInput = z.input<typeof SetOrchestratorInput>;

export const SendMessageInput = z.object({
  to: Recipient,
  body: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  kind: MessageKind.default('fyi'),
});
export type SendMessageInput = z.input<typeof SendMessageInput>;

export const ReadInboxInput = z.object({
  markRead: z.boolean().default(true),
  /** Return (and mark read) at most this many of the oldest unread messages. */
  limit: z.number().int().min(1).max(100).optional(),
});
export type ReadInboxInput = z.input<typeof ReadInboxInput>;

const TaskNumber = z.number().int().positive();

export const CreateTaskInput = z.object({
  title: z.string().trim().min(1).max(200).refine(singleLine, `task title ${SINGLE_LINE_MESSAGE}`),
  description: z.string().max(10_000).default(''),
  assignee: AgentName.optional(),
});
export type CreateTaskInput = z.input<typeof CreateTaskInput>;

export const AssignTaskInput = z.object({ task: TaskNumber, assignee: AgentName });
export type AssignTaskInput = z.input<typeof AssignTaskInput>;

export const ListTasksInput = z.object({ status: TaskStatus.optional(), assignee: AgentName.optional() });
export type ListTasksInput = z.input<typeof ListTasksInput>;

export const ClaimTaskInput = z.object({ task: TaskNumber });
export type ClaimTaskInput = z.input<typeof ClaimTaskInput>;

export const UpdateTaskInput = z.object({
  task: TaskNumber,
  status: z.enum(['in_progress', 'blocked']).optional(),
  note: z.string().trim().min(1).max(2000),
});
export type UpdateTaskInput = z.input<typeof UpdateTaskInput>;

export const CompleteTaskInput = z.object({
  task: TaskNumber,
  summary: z.string().trim().min(1).max(4000),
  branch: z.string().trim().min(1).max(255).refine(singleLine, `branch ${SINGLE_LINE_MESSAGE}`),
});
export type CompleteTaskInput = z.input<typeof CompleteTaskInput>;

const RepoGlob = z
  .string().trim().min(1).max(256)
  .refine(singleLine, `paths and globs ${SINGLE_LINE_MESSAGE}`)
  .refine((g) => !g.startsWith('/') && !g.split('/').includes('..'), 'paths and globs must be relative to the repo root');

/** A literal repo-relative file path (as opposed to a claim glob); allowed to be longer than a glob. */
export const REPO_PATH_MAX = 1024;
export const RepoPath = z
  .string().min(1).max(REPO_PATH_MAX)
  .refine(singleLine, `paths ${SINGLE_LINE_MESSAGE}`)
  .refine((g) => !g.startsWith('/') && !g.split('/').includes('..'), 'paths must be relative to the repo root');

export const ClaimFilesInput = z.object({
  globs: z.array(RepoGlob).min(1).max(50),
  exclusive: z.boolean().default(true),
  ttlMin: z.number().int().min(1).max(1440).default(DEFAULT_CLAIM_TTL_MIN),
});
export type ClaimFilesInput = z.input<typeof ClaimFilesInput>;

export const ReleaseFilesInput = z.object({ globs: z.array(RepoGlob).min(1).max(50).optional() });
export type ReleaseFilesInput = z.input<typeof ReleaseFilesInput>;

export const WhoOwnsInput = z.object({ path: RepoGlob });
export type WhoOwnsInput = z.input<typeof WhoOwnsInput>;

export const CheckFilesInput = z.object({ paths: z.array(RepoPath).min(1).max(1000) });
export type CheckFilesInput = z.input<typeof CheckFilesInput>;

export const ClaimOverrideInput = z.object({
  paths: z.array(RepoPath).min(1).max(1000),
  sha: z.string().regex(/^[0-9a-f]{7,40}$/, 'sha must be 7-40 lowercase hex characters').optional(),
});
export type ClaimOverrideInput = z.input<typeof ClaimOverrideInput>;

export const MarkMergedInput = z.object({ task: TaskNumber, pr: z.string().url().max(500).optional() });
export type MarkMergedInput = z.input<typeof MarkMergedInput>;

export const ActivityQuery = z.object({
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type ActivityQuery = z.input<typeof ActivityQuery>;

export const CommitInput = z.object({
  sha: z.string().regex(/^[0-9a-f]{7,40}$/, 'sha must be 7-40 lowercase hex characters'),
  branch: z.string().min(1).max(255).refine(singleLine, `branch ${SINGLE_LINE_MESSAGE}`),
  message: z.string().max(2000),
  files: z.array(z.string().min(1).max(1024).refine(singleLine, `file paths ${SINGLE_LINE_MESSAGE}`)).max(1000),
  insertions: z.number().int().min(0),
  deletions: z.number().int().min(0),
});
export type CommitInput = z.input<typeof CommitInput>;

export const ChangesQuery = z.object({
  agent: AgentName.optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});
export type ChangesQuery = z.input<typeof ChangesQuery>;

// ---- Replicated (git transport) ops -------------------------------------------------------------

/** A ULID: 26 Crockford base32 characters (upper case, no I L O U), first character 0-7. */
export const Ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'must be a ULID');

/** An Ed25519 public key: 32 raw bytes as unpadded base64url. */
export const PublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'public key must be 43 base64url characters');

/** Team ids in the git transport appear in ref names, so a conservative charset. */
export const ReplicatedTeamId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'invalid team id');

/** Marks the given messages read for the author; ids not visible to the author are ignored. */
export const MarkReadInput = z.object({ messageIds: z.array(Ulid).min(1).max(100) });
export type MarkReadInput = z.input<typeof MarkReadInput>;

/** Git transport `createTeam`: the creator's first op. The agent id must equal the op id. */
export const ReplicatedCreateTeamInput = z.object({
  teamId: ReplicatedTeamId,
  name: CreateTeamInput.shape.name,
  repo: RepoLink,
  member: MemberName,
  tool: ToolKind,
  agentId: Ulid,
  agentName: AgentName,
  publicKey: PublicKey,
});
export type ReplicatedCreateTeamInput = z.input<typeof ReplicatedCreateTeamInput>;

/** Git transport `join`: an agent's first op. The agent id must equal the op id. */
export const ReplicatedJoinInput = z.object({
  teamId: ReplicatedTeamId,
  member: MemberName,
  tool: ToolKind,
  agentId: Ulid,
  agentName: AgentName,
  publicKey: PublicKey,
});
export type ReplicatedJoinInput = z.input<typeof ReplicatedJoinInput>;
