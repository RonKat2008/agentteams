import SqliteDatabase from 'better-sqlite3';
import { CompiledQuery, Kysely, SqliteDialect, SqliteDriver } from 'kysely';
import type { DatabaseConnection } from 'kysely';
import type { Database } from './schema.js';

/**
 * Kysely begins transactions with a deferred BEGIN. In WAL mode a deferred transaction that reads and then
 * writes fails immediately with SQLITE_BUSY (busy_timeout is not consulted) when another process committed
 * in between. BEGIN IMMEDIATE takes the write lock up front, so concurrent processes queue on busy_timeout.
 */
class ImmediateSqliteDriver extends SqliteDriver {
  override async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin immediate'));
  }
}

class ImmediateSqliteDialect extends SqliteDialect {
  constructor(private readonly database: SqliteDatabase.Database) {
    super({ database });
  }
  override createDriver() {
    return new ImmediateSqliteDriver({ database: this.database });
  }
}

export function createSqliteDb(path: string): Kysely<Database> {
  const sqlite = new SqliteDatabase(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  return new Kysely<Database>({ dialect: new ImmediateSqliteDialect(sqlite) });
}
