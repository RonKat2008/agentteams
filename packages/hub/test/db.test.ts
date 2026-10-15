import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { createSqliteDb } from '../src/db/sqlite.js';
import { migrateToLatest } from '../src/db/migrations.js';
import type { Database } from '../src/db/schema.js';
import { createContext, withTx } from '../src/context.js';
import { DomainError, parseInput } from '../src/errors.js';
import { SendMessageInput } from '@agentteams/shared';

let db: Kysely<Database>;
beforeEach(async () => {
  db = createSqliteDb(':memory:');
  await migrateToLatest(db);
});
afterEach(async () => {
  await db.destroy();
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

describe('context', () => {
  it('generates increasing ids even within the same millisecond', () => {
    const ctx = createContext(db, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const a = ctx.newId();
    const b = ctx.newId();
    expect(b > a).toBe(true);
  });
  it('withTx rolls back on error', async () => {
    const ctx = createContext(db);
    await expect(
      withTx(ctx, async (tx) => {
        await tx.db.insertInto('agents').values(agentRow('a1', 'ronit-claude')).execute();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.selectFrom('agents').selectAll().execute()).toHaveLength(0);
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
