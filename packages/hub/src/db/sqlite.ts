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

const WAL_ATTEMPTS = 50;
const WAL_BACKOFF_MS = 20;

/** Switching a fresh file to WAL can fail with SQLITE_BUSY without consulting busy_timeout; retry briefly. */
function enableWal(sqlite: SqliteDatabase.Database): void {
  for (let attempt = 1; ; attempt++) {
    try {
      sqlite.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      if (attempt >= WAL_ATTEMPTS || !/locked|busy/i.test((err as Error).message)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAL_BACKOFF_MS);
    }
  }
}

export function createSqliteDb(path: string): Kysely<Database> {
  const sqlite = new SqliteDatabase(path);
  sqlite.pragma('busy_timeout = 5000');
  enableWal(sqlite);
  return new Kysely<Database>({ dialect: new ImmediateSqliteDialect(sqlite) });
}
