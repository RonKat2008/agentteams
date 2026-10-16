import type { Kysely } from 'kysely';
import type { Database } from './schema.js';
import { createPostgresDb } from './postgres.js';
import { createSqliteDb } from './sqlite.js';

export type Dialect = 'sqlite' | 'postgres';

export interface DbHandle {
  db: Kysely<Database>;
  dialect: Dialect;
}

/** Postgres when databaseUrl is given, otherwise SQLite at sqlitePath. */
export function createDb(opts: { sqlitePath?: string; databaseUrl?: string }): DbHandle {
  if (opts.databaseUrl) return { db: createPostgresDb(opts.databaseUrl), dialect: 'postgres' };
  if (opts.sqlitePath) return { db: createSqliteDb(opts.sqlitePath), dialect: 'sqlite' };
  throw new Error('createDb requires databaseUrl or sqlitePath');
}
