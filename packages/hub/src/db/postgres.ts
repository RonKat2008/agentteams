import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { Database } from './schema.js';

// pg returns int8 (count(), sum()) as strings by default; hub row counts are small, so parse them as numbers.
const INT8_OID = 20;
pg.types.setTypeParser(INT8_OID, (v) => Number(v));

export function createPostgresDb(databaseUrl: string): Kysely<Database> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // Idle clients can error (e.g. server restart); without a listener that would crash the process. Never log the URL.
  pool.on('error', (err) => console.error('[agentteams-hub] postgres pool error:', err.message));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
