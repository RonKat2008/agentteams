/**
 * Op capture and the op registry for the git transport.
 *
 * An op is one state-changing service call: `{v:1, id, ts, agent, op, input}` (the type lives in segment.ts).
 * - `ts` is the author's hybrid-logical-clock time (hlc.ts).
 * - `id` is a ULID minted from that same HLC time (see mintOpId): its 48-bit time field is the HLC physical
 *   millisecond and the top 14 bits of its 80-bit "random" field are the HLC counter. So for two ops with
 *   different `ts`, ULID order equals `ts` order. Replay rejects any op whose id does not match its ts.
 * - `agent` is the author's agent id. Agent ids are ULIDs minted at join time (captureBootstrapOp uses the
 *   bootstrap op's own id), exactly like the HTTP hub's, so readInbox's broadcast rule (`message.id > agent.id`)
 *   means "sent after the agent joined" on every replica. The bootstrap op's input.agentId must equal its
 *   author; the first registration of an agent id (in total order) wins.
 * - `input` is the service input after validation with the same zod schema the service/MCP tool uses.
 *
 * This module only type-imports the hub; the registry is built from the lazily imported `@agentteams/hub/core`.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  AssignTaskInput, ClaimFilesInput, ClaimOverrideInput, ClaimTaskInput, CommitInput, CompleteTaskInput, CreateTaskInput,
  MarkMergedInput, MarkReadInput, ReleaseFilesInput, ReplicatedCreateTeamInput, ReplicatedJoinInput, SendMessageInput,
  SetOrchestratorInput, UpdateTaskInput,
} from '@agentteams/shared';
import type { Actor, HubContext } from '@agentteams/hub/core';
import { parseHlc, type Hlc } from './hlc.js';
import { AGENT_ID_RE, type Op } from './segment.js';

export type { Op } from './segment.js';

type Core = typeof import('@agentteams/hub/core');

/** Every op name the log may carry, with the zod schema its input must satisfy. */
export const OP_SCHEMAS = {
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

export type OpName = keyof typeof OP_SCHEMAS;
export type BootstrapOpName = 'createTeam' | 'join';
export type RegularOpName = Exclude<OpName, BootstrapOpName>;
export type OpInput<N extends OpName> = z.input<(typeof OP_SCHEMAS)[N]>;

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
  return {
    createTeam: (ctx, actor, input) => core.createReplicatedTeam(ctx, actor.id, input as never),
    join: (ctx, actor, input) => core.registerReplicatedAgent(ctx, actor.id, input as never),
    sendMessage: (ctx, actor, input) => core.sendMessage(ctx, actor, input as never),
    markRead: (ctx, actor, input) => core.markRead(ctx, actor, input as never),
    createTask: (ctx, actor, input) => core.createTask(ctx, actor, input as never),
    assignTask: (ctx, actor, input) => core.assignTask(ctx, actor, input as never),
    claimTask: (ctx, actor, input) => core.claimTask(ctx, actor, input as never),
    updateTask: (ctx, actor, input) => core.updateTask(ctx, actor, input as never),
    completeTask: (ctx, actor, input) => core.completeTask(ctx, actor, input as never),
    markMerged: (ctx, actor, input) => core.markMerged(ctx, actor, input as never),
    claimFiles: (ctx, actor, input) => core.claimFiles(ctx, actor, input as never),
    releaseFiles: (ctx, actor, input) => core.releaseFiles(ctx, actor, input as never),
    recordCommit: (ctx, actor, input) => core.recordCommit(ctx, actor, input as never),
    recordClaimOverride: (ctx, actor, input) => core.recordClaimOverride(ctx, actor, input as never),
    setOrchestrator: (ctx, actor, input) => core.setOrchestrator(ctx, actor, input as never),
  };
}

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
 * Deterministic id source for replaying one op: the op id, then op id + 1, + 2, ... (as 128-bit integers).
 *
 * Why this keeps ids globally monotonic in total order: every id an op produces shares the op's
 * (HLC ms, HLC counter) prefix, because the 2 reserved zero bits leave 2^64 increments of headroom before
 * a carry could reach the counter. Ops are applied in (ts, agent, id) order and ts is (ms, counter), so for
 * ops with different ts every id of the earlier op sorts below every id of the later one. Two ops with
 * identical ts (different authors) get id ranges ordered by their random bits rather than by author:
 * still identical on every replica, just not tied to the author tie-break.
 */
export function opIdSequence(opId: string): () => string {
  const base = decodeUlid(opId);
  if (base === null) throw new Error(`invalid op id: ${opId}`);
  let next = 0n;
  return () => encodeUlid(base + next++);
}

// ---- Capture --------------------------------------------------------------------------------------

function validated<N extends OpName>(op: N, input: unknown): unknown {
  const result = OP_SCHEMAS[op].safeParse(input ?? {});
  if (!result.success) throw new Error(`invalid ${op} input: ${z.prettifyError(result.error)}`);
  return result.data;
}

/**
 * Captures a regular op by the given (already registered) agent: ticks the clock, mints the id from that
 * tick and stores the schema-validated input. Throws on invalid input or a bootstrap op name.
 */
export function captureOp<N extends RegularOpName>(hlc: Pick<Hlc, 'tick'>, agentId: string, op: N, input: OpInput<N>): Op {
  if (!isOpName(op) || BOOTSTRAP_OP_NAMES.has(op)) throw new Error(`not a regular op: ${String(op)}`);
  if (!AGENT_ID_RE.test(agentId)) throw new Error('invalid agent id');
  const data = validated(op, input);
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
  const data = validated(op, { ...input, agentId: id });
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
