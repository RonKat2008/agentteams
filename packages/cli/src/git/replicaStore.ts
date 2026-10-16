/**
 * Durable local files of a git team's replica, in `<git-common-dir>/agentteams/replica/<teamId>/` (0700):
 *
 *   pending/<opId>.json      this agent's ops not yet in its own log (written before they are applied locally,
 *                            so a crash never loses one; removed once a segment holding them is committed)
 *   accepted/<agentId>.jsonl every verified segment, one `{"seq":n,"ops":[...]}` line each (append-only)
 *   log-state.json           per agent: last accepted commit (`head`) and the next expected seq; key pins
 *   deferred.json            verified ops held back from replay for now (future-dated), retried every round
 *
 * Only the sync round (under the sync lock) writes accepted/, log-state.json and deferred.json, and removes
 * pending files. Writers (GitTeamClient, any process) only add pending files.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Op } from './segment.js';
import { readJson, writeJsonAtomic } from './syncState.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const OP_ID_FILE_RE = /^[0-9A-Z]{26}\.json$/;

export interface AgentLogState {
  /** Last accepted commit of the agent's ref (fast-forward checks start from here). */
  head?: string;
  /** Next seq expected; every seq below it was accepted. */
  nextSeq: number;
}

export interface LogState {
  agents: Record<string, AgentLogState>;
  /** TOFU signing-key pins (see compat.ts). */
  pins: Record<string, string>;
}

export interface AcceptedSegment { seq: number; ops: Op[] }

export interface ReplicaFiles {
  readonly dir: string;
  readLogState(): Promise<LogState>;
  writeLogState(s: LogState): Promise<void>;
  persistPending(op: Op): Promise<void>;
  listPending(): Promise<Op[]>;
  removePending(opIds: string[]): Promise<void>;
  appendAccepted(agentId: string, segments: AcceptedSegment[]): Promise<void>;
  readAccepted(agentId: string): Promise<AcceptedSegment[]>;
  acceptedAgents(): Promise<string[]>;
  readDeferred(): Promise<Op[]>;
  writeDeferred(ops: Op[]): Promise<void>;
  /** Pending ops first, then every accepted op: the order that is safe against a concurrent pending->log move. */
  allOps(): Promise<Op[]>;
}

const AGENT_FILE_RE = /^([0-9A-Za-z]{10,40})\.jsonl$/;

async function writeDurable(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w', FILE_MODE);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
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
  const pendingDir = join(dir, 'pending');
  const acceptedDir = join(dir, 'accepted');
  const statePath = join(dir, 'log-state.json');
  const deferredPath = join(dir, 'deferred.json');
  const ensure = (d: string) => mkdir(d, { recursive: true, mode: DIR_MODE });

  const files: ReplicaFiles = {
    dir,
    async readLogState() {
      const s = await readJson<Partial<LogState>>(statePath, {});
      return { agents: s.agents ?? {}, pins: s.pins ?? {} };
    },
    async writeLogState(s) {
      await ensure(dir);
      await writeJsonAtomic(statePath, s);
    },
    async persistPending(op) {
      await ensure(pendingDir);
      await writeDurable(join(pendingDir, `${op.id}.json`), JSON.stringify(op));
    },
    async listPending() {
      const ops: Op[] = [];
      for (const name of (await listDir(pendingDir)).filter((n) => OP_ID_FILE_RE.test(n)).sort()) {
        try {
          ops.push(JSON.parse(await readFile(join(pendingDir, name), 'utf8')) as Op);
        } catch { /* removed concurrently, or torn: a torn file was never acknowledged to the caller */ }
      }
      return ops.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    async removePending(opIds) {
      for (const id of opIds) await unlink(join(pendingDir, `${id}.json`)).catch(() => undefined);
    },
    async appendAccepted(agentId, segments) {
      if (segments.length === 0) return;
      await ensure(acceptedDir);
      const fh = await open(join(acceptedDir, `${agentId}.jsonl`), 'a', FILE_MODE);
      try {
        await fh.appendFile(segments.map((s) => `${JSON.stringify({ seq: s.seq, ops: s.ops })}\n`).join(''));
        await fh.sync();
      } finally {
        await fh.close();
      }
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
    async allOps() {
      const pending = await files.listPending();
      const accepted: Op[] = [];
      for (const agent of await files.acceptedAgents()) {
        for (const seg of await files.readAccepted(agent)) accepted.push(...seg.ops);
      }
      return [...pending, ...accepted];
    },
  };
  return files;
}
