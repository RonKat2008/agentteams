import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
