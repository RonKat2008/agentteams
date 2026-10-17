import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { makeTestDb, type TestDb } from './helpers.js';
import { migrateTo, migrateToLatest } from '../src/db/migrations.js';
import type { Database } from '../src/db/schema.js';
import { createContext, withTx } from '../src/context.js';
import { DomainError, parseInput } from '../src/errors.js';
import { SendMessageInput } from '@agentteams/shared';

let handle: TestDb;
let db: Kysely<Database>;
beforeEach(async () => {
  handle = makeTestDb();
  db = handle.db;
  await migrateToLatest(db);
});
afterEach(async () => {
  await handle.close();
});

const agentRow = (id: string, name: string) => ({
  id, team_id: 't1', name, member: 'ronit', tool: 'claude' as const,
  api_key_hash: `h-${id}`, last_seen_at: null, created_at: '2026-01-01T00:00:00.000Z',
});

describe('migrations', () => {
  it('creates every table', async () => {
    const tables = (await db.introspection.getTables()).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(['activity', 'agents', 'claims', 'commits', 'message_reads', 'messages', 'tasks', 'teams']),
    );
  });
  it('is idempotent', async () => {
    await expect(migrateToLatest(db)).resolves.toBeUndefined();
  });
  it('enforces unique agent names per team', async () => {
    await db.insertInto('agents').values(agentRow('a1', 'ronit-claude')).execute();
    await expect(db.insertInto('agents').values(agentRow('a2', 'ronit-claude')).execute()).rejects.toThrow();
  });
});

describe('migration 002_git_layer', () => {
  it('dedupes existing commit rows (keeping the lowest id) and adds tasks.merged_at', async () => {
    const freshHandle = makeTestDb();
    const fresh = freshHandle.db;
    try {
      await migrateTo(fresh, '0001_init');
      const row = (id: string, sha: string) => ({
        id, team_id: 't1', agent_id: 'a1', sha, branch: 'b', message: 'm', files_json: '[]',
        insertions: 0, deletions: 0, created_at: '2026-01-01T00:00:00.000Z',
      });
      await fresh.insertInto('commits').values([row('c1', 'abc1234'), row('c2', 'abc1234'), row('c3', 'def5678')]).execute();
      await migrateToLatest(fresh);
      const ids = (await fresh.selectFrom('commits').select('id').orderBy('id').execute()).map((r) => r.id);
      expect(ids).toEqual(['c1', 'c3']);
      await expect(fresh.insertInto('commits').values(row('c4', 'abc1234')).execute()).rejects.toThrow();
      const cols = (await fresh.introspection.getTables()).find((t) => t.name === 'tasks')!.columns.map((c) => c.name);
      expect(cols).toContain('merged_at');
    } finally {
      await freshHandle.close();
    }
  });
});

describe('context', () => {
  it('generates increasing ids even within the same millisecond', () => {
    const ctx = createContext(db, { dialect: handle.dialect, now: () => new Date('2026-01-01T00:00:00.000Z') });
    const a = ctx.newId();
    const b = ctx.newId();
    expect(b > a).toBe(true);
  });
  it('withTx rolls back on error', async () => {
    const ctx = createContext(db, { dialect: handle.dialect });
    await expect(
      withTx(ctx, async (tx) => {
        await tx.db.insertInto('agents').values(agentRow('a1', 'ronit-claude')).execute();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.selectFrom('agents').selectAll().execute()).toHaveLength(0);
  });
});

describe('withTx retry', () => {
  const serializationError = () => Object.assign(new Error('could not serialize access'), { code: '40001' });

  it('retries a serialization failure on postgres and succeeds', async () => {
    const ctx = createContext(db, { dialect: 'postgres' });
    let calls = 0;
    const out = await withTx(ctx, async () => {
      calls++;
      if (calls === 1) throw serializationError();
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(2);
  });
  it('gives up after 3 attempts with a conflict DomainError', async () => {
    const ctx = createContext(db, { dialect: 'postgres' });
    let calls = 0;
    await expect(withTx(ctx, async () => { calls++; throw serializationError(); })).rejects.toMatchObject({
      code: 'conflict', message: 'the hub is busy; retry the request',
    });
    expect(calls).toBe(3);
  });
  it('does not retry other errors', async () => {
    const ctx = createContext(db, { dialect: 'postgres' });
    let calls = 0;
    await expect(withTx(ctx, async () => { calls++; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
  it('does not retry on sqlite', async () => {
    const ctx = createContext(db, { dialect: 'sqlite' });
    let calls = 0;
    await expect(withTx(ctx, async () => { calls++; throw serializationError(); })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('parseInput', () => {
  it('returns parsed output with defaults', () => {
    expect(parseInput(SendMessageInput, { to: 'all', body: 'hi' }).kind).toBe('fyi');
  });
  it('throws DomainError(invalid) with a readable message', () => {
    try {
      parseInput(SendMessageInput, { to: 'all', body: '' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('invalid');
      expect((err as DomainError).message).toContain('body');
    }
  });
});

describe('migration 005_github_id_bigint', () => {
  const BIG_ID = 5_000_000_000; // above int32

  it('stores GitHub ids beyond 2^31 and reads them back as numbers', async () => {
    await db.insertInto('agents').values({ ...agentRow('big', 'big-claude'), github_id: BIG_ID }).execute();
    const row = await db.selectFrom('agents').select('github_id').where('id', '=', 'big').executeTakeFirstOrThrow();
    expect(Number(row.github_id)).toBe(BIG_ID);
  });

  it('on Postgres the column is int8', async () => {
    if (handle.dialect !== 'postgres') return;
    const res = await sql<{ data_type: string }>`SELECT data_type FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'github_id'`.execute(db);
    expect(res.rows[0]?.data_type).toBe('bigint');
  });
});

describe('migration 006_replication', () => {
  it('keys applied_ops by (agent, op_id, hash), adds the pins and pending tables, and scopes commits per agent', async () => {
    const freshHandle = makeTestDb();
    const fresh = freshHandle.db as unknown as Kysely<any>;
    try {
      await migrateToLatest(freshHandle.db);
      const row = (k: string, agent: string, hash: string) => ({ agent, op_id: k, hash, ts: null, status: 'rejected', error: 'x' });
      await fresh.insertInto('applied_ops')
        .values([row('op1', 'agentA0000', 'h'), row('op1', 'agentB0000', 'h'), row('op1', 'agentA0000', 'h2')]).execute();
      await expect(fresh.insertInto('applied_ops').values(row('op1', 'agentA0000', 'h')).execute()).rejects.toThrow();
      const notice = (agent: string) => ({ op_id: 'op9', agent_id: agent, body: 'hello', created_at: 'now', delivered_at: null });
      await fresh.insertInto('replica_notices').values([notice('agentA0000'), notice('agentB0000')]).execute();
      await expect(fresh.insertInto('replica_notices').values(notice('agentA0000')).execute()).rejects.toThrow();
      await fresh.insertInto('agent_key_pins').values({ agent_id: 'agentA0000', public_key: 'k', pinned_at: 'now' }).execute();
      await fresh.insertInto('team_meta_pins').values({ team_id: 't1', meta_json: '{}', pinned_at: 'now' }).execute();
      const pending = { agent_id: 'agentA0000', op_id: 'op1', ts: 't', op_json: '{}', created_at: 'now' };
      await fresh.insertInto('replica_pending').values(pending).execute();
      await expect(fresh.insertInto('replica_pending').values(pending).execute()).rejects.toThrow();

      const commit = (id: string, agent: string) => ({
        id, team_id: 't1', agent_id: agent, sha: 'abc1234', branch: 'b', message: 'm', files_json: '[]',
        insertions: 0, deletions: 0, created_at: '2026-01-01T00:00:00.000Z',
      });
      await fresh.insertInto('commits').values(commit('c1', 'a1')).execute();
      await fresh.insertInto('commits').values(commit('c2', 'a2')).execute(); // same sha+branch, another agent: allowed
      await expect(fresh.insertInto('commits').values(commit('c3', 'a1')).execute()).rejects.toThrow(); // same agent: not
      expect(await fresh.selectFrom('replica_state').selectAll().execute()).toEqual([]);
    } finally {
      await freshHandle.close();
    }
  });
});
