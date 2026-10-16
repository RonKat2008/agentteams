import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { Database } from './schema.js';

// pg returns int8 (count(), sum()) as strings by default; hub row counts are small, so parse them as numbers.
const INT8_OID = 20;
pg.types.setTypeParser(INT8_OID, (v) => Number(v));

export function createPostgresDb(databaseUrl: string): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: databaseUrl, max: 10 }) }) });
}
