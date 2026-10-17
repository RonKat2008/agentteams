/**
 * Durable local state of a git team's replica.
 *
 * In team.db (local tables that a rebuild never touches):
 *   replica_pending          this agent's ops not yet in its published log, written in the SAME transaction as
 *                            the op's local apply (view.ts), removed once a segment holding them is committed
 *   agent_key_pins / team_meta_pins   TOFU pins (replay.ts pinAgentKey / pinTeamMeta)
 *
 * In `<git-common-dir>/agentteams/replica/<teamId>/` (0700), written only by a round under the sync lock:
 *   accepted/<agentId>.jsonl every verified segment, one `{"seq":n,"blob":"<git blob id>","ops":[...]}` line each
 *                            (append-only; the blob id is the content hash an accepted seq is compared against)
 *   log-state.json           per agent: next seq, last accepted blob, last accepted presence, the last tip fully
 *                            processed; plus the round-robin offset of the ingest budget
 *   deferred.json            verified ops held back from replay for now (future-dated), offered every round
 */
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database, Kysely } from '@agentteams/hub/core';
import type { Op } from './segment.js';
import { readJson, syncDir, writeJsonAtomic } from './syncState.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const OP_ID_FILE_RE = /^[0-9A-Z]{26}\.json$/;
const AGENT_FILE_RE = /^([0-9A-Za-z]{10,40})\.jsonl$/;

type Db = Kysely<Database>;

export interface AgentLogState {
  /** Next seq expected; every seq below it was accepted (lastAcceptedSeq + 1). */
  nextSeq: number;
  /** Git blob id (content hash) of seq nextSeq - 1: different content there later is equivocation or vandalism. */
  lastBlob?: string;
  /** Last accepted presence; a newer (ts, counter) only. */
  presence?: { ts: number; counter: number; blob: string };
  /**
   * A tip whose tree was fully processed (every path from nextSeq looked up, presence read): a cache only, since a
   * commit id names its content. Skipping it saves work; it is never compared for ancestry.
   */
  doneTip?: string;
  /** Set with doneTip when ingestion stopped on refused data at that tip (it resumes on any other tip). */
  stuck?: boolean;
}

export interface LogState {
  agents: Record<string, AgentLogState>;
  /** Rotating start of the per-round ingest budget (round-robin across agents). */
  rotation?: number;
}

export interface AcceptedSegment { seq: number; ops: Op[]; blob?: string }

export interface ReplicaFiles {
  readonly dir: string;
  readLogState(): Promise<LogState>;
  /**
   * Updates one agent's entry (read-modify-write under the sync lock). With `expected` (null = no entry yet), a
   * compare-and-swap: throws RefMovedError when the stored entry is no longer that value (another round moved it).
   */
  setAgentState(agentId: string, s: AgentLogState, expected?: AgentLogState | null): Promise<void>;
  setRotation(n: number): Promise<void>;
  appendAccepted(agentId: string, segments: AcceptedSegment[]): Promise<void>;
  readAccepted(agentId: string): Promise<AcceptedSegment[]>;
  acceptedAgents(): Promise<string[]>;
  acceptedOps(): Promise<Op[]>;
  readDeferred(): Promise<Op[]>;
  writeDeferred(ops: Op[]): Promise<void>;
  /** One-time migration from the first Task 7 layout: pins kept in log-state.json, pending ops as files. */
  takeLegacy(): Promise<{ pins: Record<string, string>; pending: Op[] }>;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export function replicaFiles(agentteamsDir: string, teamId: string): ReplicaFiles {
  if (!/^[0-9A-Za-z]{10,40}$/.test(teamId)) throw new Error(`invalid team id: ${JSON.stringify(teamId)}`);
  const dir = join(agentteamsDir, 'replica', teamId);
  const acceptedDir = join(dir, 'accepted');
  const legacyPendingDir = join(dir, 'pending');
  const statePath = join(dir, 'log-state.json');
  const deferredPath = join(dir, 'deferred.json');
  const ensure = (d: string) => mkdir(d, { recursive: true, mode: DIR_MODE });

  const readRaw = () => readJson<{ agents?: Record<string, AgentLogState>; rotation?: number; pins?: Record<string, string> }>(statePath, {});

  const files: ReplicaFiles = {
    dir,
    async readLogState() {
      const raw = await readRaw();
      return { agents: raw.agents ?? {}, rotation: Number.isSafeInteger(raw.rotation) ? raw.rotation : 0 };
    },
    async setAgentState(agentId, s, expected) {
      const raw = await readRaw();
      if (expected !== undefined && JSON.stringify(raw.agents?.[agentId] ?? null) !== JSON.stringify(expected)) {
        throw Object.assign(new Error(`log state of ${agentId} moved unexpectedly; stopping`), { name: 'RefMovedError' });
      }
      await ensure(dir);
      await writeJsonAtomic(statePath, { ...raw, agents: { ...(raw.agents ?? {}), [agentId]: s } });
    },
    async setRotation(n) {
      const raw = await readRaw();
      await ensure(dir);
      await writeJsonAtomic(statePath, { ...raw, rotation: n });
    },
    async appendAccepted(agentId, segments) {
      if (segments.length === 0) return;
      await ensure(acceptedDir);
      const fh = await open(join(acceptedDir, `${agentId}.jsonl`), 'a', FILE_MODE);
      try {
        await fh.appendFile(segments.map((s) => `${JSON.stringify({ seq: s.seq, blob: s.blob, ops: s.ops })}\n`).join(''));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await syncDir(acceptedDir);
    },
    async readAccepted(agentId) {
      let text: string;
      try {
        text = await readFile(join(acceptedDir, `${agentId}.jsonl`), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const bySeq = new Map<number, AcceptedSegment>();
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const s = JSON.parse(line) as AcceptedSegment;
          // A crash between append and log-state save re-appends a segment: first copy wins.
          if (Number.isSafeInteger(s.seq) && Array.isArray(s.ops) && !bySeq.has(s.seq)) bySeq.set(s.seq, s);
        } catch { /* torn last line from a crash; the segment is re-ingested */ }
      }
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    },
    async acceptedAgents() {
      return (await listDir(acceptedDir)).map((n) => AGENT_FILE_RE.exec(n)?.[1]).filter((x): x is string => Boolean(x)).sort();
    },
    async acceptedOps() {
      const ops: Op[] = [];
      for (const agent of await files.acceptedAgents()) {
        for (const seg of await files.readAccepted(agent)) ops.push(...seg.ops);
      }
      return ops;
    },
    async readDeferred() {
      try {
        const v: unknown = JSON.parse(await readFile(deferredPath, 'utf8'));
        return Array.isArray(v) ? (v as Op[]) : [];
      } catch {
        return [];
      }
    },
    async writeDeferred(ops) {
      await ensure(dir);
      await writeJsonAtomic(deferredPath, ops);
    },
    async takeLegacy() {
      const raw = await readRaw();
      const pins = raw.pins ?? {};
      const pending: Op[] = [];
      const names = (await listDir(legacyPendingDir)).filter((n) => OP_ID_FILE_RE.test(n));
      for (const name of names) {
        try {
          pending.push(JSON.parse(await readFile(join(legacyPendingDir, name), 'utf8')) as Op);
        } catch { /* torn: never acknowledged */ }
      }
      return { pins, pending }; // the caller stores both in team.db, then calls dropLegacy
    },
  };
  return files;
}

/** Removes the legacy pins and pending files once they are stored in team.db. */
export async function dropLegacy(files: ReplicaFiles, migratedPendingIds: string[]): Promise<void> {
  const statePath = join(files.dir, 'log-state.json');
  const raw = await readJson<{ agents?: Record<string, AgentLogState>; rotation?: number; pins?: Record<string, string> }>(statePath, {});
  if (raw.pins !== undefined) {
    const { pins: _dropped, ...rest } = raw;
    await writeJsonAtomic(statePath, rest);
  }
  for (const id of migratedPendingIds) await unlink(join(files.dir, 'pending', `${id}.json`)).catch(() => undefined);
}

// ---- Pending ops in team.db --------------------------------------------------------------------------

export interface PendingKey { agent: string; id: string }

export async function insertPending(db: Db, op: Op, nowIso: string): Promise<void> {
  await db.insertInto('replica_pending')
    .values({ agent_id: op.agent, op_id: op.id, ts: op.ts, op_json: JSON.stringify(op), created_at: nowIso })
    .onConflict((oc) => oc.columns(['agent_id', 'op_id']).doNothing())
    .execute();
}

/** Pending ops, oldest first (all local agents, or one). */
export async function listPending(db: Db, agentId?: string): Promise<Op[]> {
  let q = db.selectFrom('replica_pending').select('op_json').orderBy('ts').orderBy('agent_id').orderBy('op_id');
  if (agentId !== undefined) q = q.where('agent_id', '=', agentId);
  return (await q.execute()).map((r) => JSON.parse(r.op_json) as Op);
}

export async function removePending(db: Db, keys: PendingKey[]): Promise<void> {
  for (const k of keys) {
    await db.deleteFrom('replica_pending').where('agent_id', '=', k.agent).where('op_id', '=', k.id).execute();
  }
}

/** Identity of an op is (agent, id). */
export const opKey = (o: { agent: string; id: string }): string => `${o.agent}\0${o.id}`;
