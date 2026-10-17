/**
 * Op capture and the op registry for the git transport.
 *
 * An op is one state-changing service call: `{v:1, id, ts, agent, op, input}` (the type lives in segment.ts).
 * - `ts` is the author's hybrid-logical-clock time (hlc.ts).
 * - `id` is a ULID minted from that same HLC time (see mintOpId): its 48-bit time field is the HLC physical
 *   millisecond and the top 14 bits of its 80-bit "random" field are the HLC counter. So for two ops with
 *   different `ts`, ULID order equals `ts` order. Replay rejects any op whose id does not match its ts.
 * - `agent` is the author's agent id: the id of its own bootstrap op (`createTeam`/`join` require
 *   op.id === op.agent === input.agentId), so agent ids are ULIDs minted from the join's HLC time, like the
 *   HTTP hub's, and readInbox's broadcast rule (`message.id > agent.id`) means "sent after the agent joined"
 *   (at millisecond granularity) on every replica.
 * - An op's identity is (agent, id): different agents can never shadow or collide with each other's ops.
 * - `input` is the service input after validation with the same zod schema the service/MCP tool uses.
 *
 * This module only type-imports the hub; the registry is built from the lazily imported `@agentteams/hub/core`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  AssignTaskInput, ClaimFilesInput, ClaimOverrideInput, ClaimTaskInput, CommitInput, CompleteTaskInput, CreateTaskInput,
  MarkMergedInput, MarkReadInput, ReleaseFilesInput, ReplicatedCreateTeamInput, ReplicatedJoinInput, SendMessageInput,
  SetOrchestratorInput, Ulid, UpdateTaskInput,
} from '@agentteams/shared';
import type { Actor, HubContext } from '@agentteams/hub/core';
import { parseHlc, type Hlc } from './hlc.js';
import { AGENT_ID_RE, type Op } from './segment.js';

export type { Op } from './segment.js';

type Core = typeof import('@agentteams/hub/core');

/**
 * What callers pass to capture, per op: the same schemas the services and MCP tools use, so agents are
 * addressed by name.
 */
export const CAPTURE_SCHEMAS = {
  createTeam: ReplicatedCreateTeamInput,
  join: ReplicatedJoinInput,
  sendMessage: SendMessageInput,
  markRead: MarkReadInput,
  createTask: CreateTaskInput,
  assignTask: AssignTaskInput,
  claimTask: ClaimTaskInput,
  updateTask: UpdateTaskInput,
  completeTask: CompleteTaskInput,
  markMerged: MarkMergedInput,
  claimFiles: ClaimFilesInput,
  releaseFiles: ReleaseFilesInput,
  recordCommit: CommitInput,
  recordClaimOverride: ClaimOverrideInput,
  setOrchestrator: SetOrchestratorInput,
} as const satisfies Record<string, z.ZodType>;

/** An agent targeted by an op, on the wire: its id (names can be squatted or suffixed; ids cannot). */
const AgentRef = Ulid;
/** A task targeted by an op, on the wire: its row id (numbers shift when a late createTask replays earlier). */
const TaskRef = Ulid;

/**
 * What the log carries, per op. Identical to CAPTURE_SCHEMAS except that every field naming an agent
 * (TARGET_FIELDS) carries the agent id and every task number (TASK_FIELDS) carries the task's row id,
 * both resolved at capture time against the author's view.
 */
export const OP_SCHEMAS = {
  ...CAPTURE_SCHEMAS,
  sendMessage: SendMessageInput.extend({ to: z.union([z.literal('all'), AgentRef]) }),
  createTask: CreateTaskInput.extend({ assignee: AgentRef.optional() }),
  assignTask: AssignTaskInput.extend({ task: TaskRef, assignee: AgentRef }),
  claimTask: ClaimTaskInput.extend({ task: TaskRef }),
  updateTask: UpdateTaskInput.extend({ task: TaskRef }),
  completeTask: CompleteTaskInput.extend({ task: TaskRef }),
  markMerged: MarkMergedInput.extend({ task: TaskRef }),
  setOrchestrator: SetOrchestratorInput.extend({ agent: AgentRef }),
} as const satisfies Record<keyof typeof CAPTURE_SCHEMAS, z.ZodType>;

/** Input fields that name an agent: captured as names, carried and replayed as ids. */
export const TARGET_FIELDS = {
  sendMessage: 'to',
  createTask: 'assignee',
  assignTask: 'assignee',
  setOrchestrator: 'agent',
} as const satisfies Partial<Record<keyof typeof CAPTURE_SCHEMAS, string>>;

/** Input fields that name a task: captured as task numbers, carried and replayed as task row ids. */
export const TASK_FIELDS = {
  assignTask: 'task',
  claimTask: 'task',
  updateTask: 'task',
  completeTask: 'task',
  markMerged: 'task',
} as const satisfies Partial<Record<keyof typeof CAPTURE_SCHEMAS, string>>;

export type OpName = keyof typeof OP_SCHEMAS;
export type BootstrapOpName = 'createTeam' | 'join';
export type RegularOpName = Exclude<OpName, BootstrapOpName>;
/** Capture-time input (agents by name). */
export type OpInput<N extends OpName> = z.input<(typeof CAPTURE_SCHEMAS)[N]>;

/** Name/number to id lookups over the author's current view (see replay.ts loadAgentDirectory). */
export interface AgentDirectory {
  /** Agent name -> agent id. */
  idOf(name: string): string | undefined;
  /** Task number -> task row id. Required to capture task ops (claimTask, assignTask, ...). */
  taskIdOf?(number: number): string | undefined;
}

/** Ops that register their author's key. They must be the only op of the author's seq-0 segment. */
export const BOOTSTRAP_OP_NAMES: ReadonlySet<string> = new Set<BootstrapOpName>(['createTeam', 'join']);

export function isOpName(name: unknown): name is OpName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(OP_SCHEMAS, name);
}

/**
 * Applies an op by calling the real service. For bootstrap ops the actor is provisional (only `id`, the
 * author, is meaningful); for every other op it is the author's agents row.
 */
export type OpHandler = (ctx: HubContext, actor: Actor, input: unknown) => Promise<unknown>;

/**
 * Covers every state-changing path of the MCP tools, hooks and CLI. Deliberately absent:
 * - presence / last_seen_at (authenticate's heartbeat): not an op, replicated separately;
 * - rotateInvite / revokeInvite / createTeam / joinTeam with invite codes and API keys: HTTP/local teams only
 *   (git teams are created and joined through the createTeam/join bootstrap ops);
 * - reads (readInbox without its side effect, status, activity, changes, whoOwns, checkFiles).
 */
export function buildRegistry(core: Core): Readonly<Record<OpName, OpHandler>> {
  /** Replay adapter: the services address agents by name; the log carries ids. The view is deterministic. */
  const nameOf = async (ctx: HubContext, actor: Actor, id: string): Promise<string> => {
    const row = await ctx.db.selectFrom('agents').select('name')
      .where('team_id', '=', actor.teamId).where('id', '=', id).executeTakeFirst();
    if (!row) throw new core.DomainError('not_found', 'the target agent is not in this team');
    return row.name;
  };
  const withName = <K extends string>(field: K) => async (ctx: HubContext, actor: Actor, input: unknown) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const v = i[field];
    if (typeof v !== 'string' || v === 'all') return i;
    return { ...i, [field]: await nameOf(ctx, actor, v) };
  };
  const to = withName('to');
  const assignee = withName('assignee');
  const agent = withName('agent');
  /** Replay adapter: the services address tasks by number; the log carries row ids. */
  const withNumber = async (ctx: HubContext, actor: Actor, input: unknown): Promise<Record<string, unknown>> => {
    const i = (input ?? {}) as Record<string, unknown>;
    if (typeof i.task !== 'string') return i;
    const row = await ctx.db.selectFrom('tasks').select('number')
      .where('team_id', '=', actor.teamId).where('id', '=', i.task).executeTakeFirst();
    if (!row) throw new core.DomainError('not_found', 'the target task is not in this team');
    return { ...i, task: row.number };
  };
  return {
    createTeam: (ctx, actor, input) => core.createReplicatedTeam(ctx, actor.id, input as never),
    join: (ctx, actor, input) => core.registerReplicatedAgent(ctx, actor.id, input as never),
    sendMessage: async (ctx, actor, input) => core.sendMessage(ctx, actor, (await to(ctx, actor, input)) as never),
    markRead: (ctx, actor, input) => core.markRead(ctx, actor, input as never),
    createTask: async (ctx, actor, input) => core.createTask(ctx, actor, (await assignee(ctx, actor, input)) as never),
    assignTask: async (ctx, actor, input) =>
      core.assignTask(ctx, actor, (await assignee(ctx, actor, await withNumber(ctx, actor, input))) as never),
    claimTask: async (ctx, actor, input) => core.claimTask(ctx, actor, (await withNumber(ctx, actor, input)) as never),
    updateTask: async (ctx, actor, input) => core.updateTask(ctx, actor, (await withNumber(ctx, actor, input)) as never),
    completeTask: async (ctx, actor, input) => core.completeTask(ctx, actor, (await withNumber(ctx, actor, input)) as never),
    markMerged: async (ctx, actor, input) => core.markMerged(ctx, actor, (await withNumber(ctx, actor, input)) as never),
    claimFiles: (ctx, actor, input) => core.claimFiles(ctx, actor, input as never),
    releaseFiles: (ctx, actor, input) => core.releaseFiles(ctx, actor, input as never),
    recordCommit: (ctx, actor, input) => core.recordCommit(ctx, actor, input as never),
    recordClaimOverride: (ctx, actor, input) => core.recordClaimOverride(ctx, actor, input as never),
    setOrchestrator: async (ctx, actor, input) => core.setOrchestrator(ctx, actor, (await agent(ctx, actor, input)) as never),
  };
}

/**
 * Ops that can succeed without doing what their author wanted. The op stays applied (the outcome is part
 * of the deterministic view) but its author gets a local notice with the returned text.
 */
export const OUTCOME_NOTICES: Partial<Record<OpName, (result: unknown, input: unknown) => string | null>> = {
  join: (result, input) => {
    const got = (result as { agentName?: unknown } | null)?.agentName;
    const wanted = (input as { agentName?: unknown } | null)?.agentName;
    return typeof got === 'string' && got !== wanted ? `you joined as "${got}" because "${String(wanted)}" was already taken` : null;
  },
  claimFiles: (result) => {
    const r = result as { granted?: boolean; conflicts?: Array<{ agent: string; glob: string }> } | null;
    if (!r || (r.granted !== false && (r.conflicts?.length ?? 0) === 0)) return null;
    const held = (r.conflicts ?? []).map((c) => `${c.glob} (${c.agent})`).join(', ');
    return `your file claim was refused by the team log${held ? `: already claimed ${held}` : ''}`;
  },
};

// ---- ULIDs derived from HLC time -----------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ULID_LEN = 26;
const RANDOM_BITS = 80n;
const COUNTER_SHIFT = 66n; // counter occupies bits 66..79 of the 80-bit field (9999 < 2^14)
const RANDOM_MASK = (1n << 64n) - 1n; // bits 0..63 random; bits 64..65 reserved zero (successor headroom)
const LOW_MASK = (1n << COUNTER_SHIFT) - 1n;

function encodeUlid(n: bigint): string {
  let out = '';
  let v = n;
  for (let i = 0; i < ULID_LEN; i++) {
    out = CROCKFORD[Number(v & 31n)]! + out;
    v >>= 5n;
  }
  return out;
}

function decodeUlid(id: string): bigint | null {
  if (!ULID_RE.test(id)) return null;
  let v = 0n;
  for (const ch of id) v = (v << 5n) | BigInt(CROCKFORD.indexOf(ch));
  return v;
}

/**
 * Mints an op id for an HLC timestamp: time = HLC ms, then counter(14 bits) | 00 | random(64 bits).
 * Throws on a malformed timestamp.
 */
export function mintOpId(ts: string, random: () => bigint = () => randomBytes(8).readBigUInt64BE()): string {
  const t = parseHlc(ts);
  if (!t) throw new Error(`invalid HLC timestamp: ${ts}`);
  const low = (BigInt(t.counter) << COUNTER_SHIFT) | (random() & RANDOM_MASK);
  return encodeUlid((BigInt(t.ms) << RANDOM_BITS) | low);
}

/** True when `id` is exactly what mintOpId could produce for `ts` (time, counter and reserved bits). */
export function opIdMatchesTs(id: unknown, ts: unknown): boolean {
  if (typeof id !== 'string') return false;
  const t = parseHlc(ts);
  const v = decodeUlid(id);
  if (!t || v === null) return false;
  const ms = v >> RANDOM_BITS;
  const counter = (v >> COUNTER_SHIFT) & ((1n << 14n) - 1n);
  const reserved = (v & LOW_MASK) >> 64n;
  return ms === BigInt(t.ms) && counter === BigInt(t.counter) && reserved === 0n;
}

/**
 * Deterministic row-id source for replaying one op by `agent`: the n-th id (n = 0, 1, ...) is the ULID
 * with time = the op's HLC millisecond and random part = the first 80 bits of SHA-256(agent \0 opId \0 n).
 *
 * - Time-ordered: rows of an op sort after every row of ops in earlier milliseconds and before every row of
 *   ops in later ones, which is what readInbox's broadcast rule (`m.id > actor.id`) needs. Within one
 *   millisecond (same op, or several ops sharing the ms) the order is deterministic but arbitrary.
 * - Bound to the author: the random part hashes (agent, op id, n), so an agent cannot aim its rows at
 *   another agent's ids; a collision needs an 80-bit truncated SHA-256 second preimage.
 */
export function rowIdSequence(agent: string, opId: string, ts: string): () => string {
  const t = parseHlc(ts);
  if (!t) throw new Error(`invalid HLC timestamp: ${ts}`);
  const time = BigInt(t.ms) << RANDOM_BITS;
  let n = 0;
  return () => {
    const digest = createHash('sha256').update(`${agent}\0${opId}\0${n++}`).digest();
    return encodeUlid(time | BigInt(`0x${digest.subarray(0, 10).toString('hex')}`));
  };
}

// ---- Capture --------------------------------------------------------------------------------------

function validated(schema: z.ZodType, op: string, input: unknown): unknown {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw new Error(`invalid ${op} input: ${z.prettifyError(result.error)}`);
  return result.data;
}

/** Replaces the agent name in the op's target field (if any) by that agent's id; 'all' stays. */
function resolveTargets(op: OpName, input: unknown, directory: AgentDirectory): unknown {
  let out = input as Record<string, unknown>;
  const field = (TARGET_FIELDS as Partial<Record<OpName, string>>)[op];
  if (field && typeof out[field] === 'string' && out[field] !== 'all') {
    const name = out[field] as string;
    const id = directory.idOf(name);
    if (!id) throw new Error(`no agent named "${name}" in this team`);
    out = { ...out, [field]: id };
  }
  const taskField = (TASK_FIELDS as Partial<Record<OpName, string>>)[op];
  if (taskField && typeof out[taskField] === 'number') {
    const number = out[taskField] as number;
    if (!directory.taskIdOf) throw new Error(`capturing ${op} needs a directory with task lookups`);
    const id = directory.taskIdOf(number);
    if (!id) throw new Error(`task #${number} not found`);
    out = { ...out, [taskField]: id };
  }
  return out;
}

/**
 * Captures a regular op by the given (already registered) agent: validates the input with the service
 * schema, resolves agent names to ids against `directory` (the author's current view; unknown names throw),
 * ticks the clock and mints the id from that tick. Throws on invalid input or a bootstrap op name.
 */
export function captureOp<N extends RegularOpName>(
  hlc: Pick<Hlc, 'tick'>, agentId: string, op: N, input: OpInput<N>, directory: AgentDirectory,
): Op {
  if (!isOpName(op) || BOOTSTRAP_OP_NAMES.has(op)) throw new Error(`not a regular op: ${String(op)}`);
  if (!AGENT_ID_RE.test(agentId)) throw new Error('invalid agent id');
  const named = validated(CAPTURE_SCHEMAS[op], op, input);
  const data = validated(OP_SCHEMAS[op], op, resolveTargets(op, named, directory));
  const ts = hlc.tick();
  return { v: 1, id: mintOpId(ts), ts, agent: agentId, op, input: data };
}

/**
 * Captures a bootstrap op (`createTeam` or `join`). The new agent's id is minted here (it is the op's own
 * id) and returned with the op. The op must be the only op of the agent's seq-0 segment.
 */
export function captureBootstrapOp<N extends BootstrapOpName>(
  hlc: Pick<Hlc, 'tick'>, op: N, input: Omit<OpInput<N>, 'agentId'>,
): { agentId: string; op: Op } {
  const ts = hlc.tick();
  const id = mintOpId(ts);
  const data = validated(OP_SCHEMAS[op], op, { ...input, agentId: id });
  return { agentId: id, op: { v: 1, id, ts, agent: id, op, input: data } };
}

// ---- Ordering and identity ------------------------------------------------------------------------

/** Total order of ops: (ts, agent, id), plain string comparison. */
export function compareOps(a: Pick<Op, 'ts' | 'agent' | 'id'>, b: Pick<Op, 'ts' | 'agent' | 'id'>): number {
  return cmp(a.ts, b.ts) || cmp(a.agent, b.agent) || cmp(a.id, b.id);
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON with object keys sorted, so equal ops hash equally whatever their key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, sortKeys(obj[k])]));
}
