import type { Kysely } from 'kysely';
import type { Database } from './schema.js';
import { createPostgresDb } from './postgres.js';

export type Dialect = 'sqlite' | 'postgres';

export interface DbHandle {
  db: Kysely<Database>;
  dialect: Dialect;
}

/**
 * Postgres when databaseUrl is given, otherwise SQLite at sqlitePath. SQLite is loaded with a dynamic
 * import so a Postgres-only deployment (the Vercel function) never loads the native better-sqlite3 module.
 */
export async function createDb(opts: { sqlitePath?: string; databaseUrl?: string }): Promise<DbHandle> {
  if (opts.databaseUrl) return { db: createPostgresDb(opts.databaseUrl), dialect: 'postgres' };
  if (opts.sqlitePath) {
    const { createSqliteDb } = await import('./sqlite.js');
    return { db: createSqliteDb(opts.sqlitePath), dialect: 'sqlite' };
  }
  throw new Error('createDb requires databaseUrl or sqlitePath');
}
