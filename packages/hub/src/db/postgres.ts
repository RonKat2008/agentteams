import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { Database } from './schema.js';

// pg returns int8 (count(), sum()) as strings by default; hub row counts are small, so parse them as numbers.
const INT8_OID = 20;
pg.types.setTypeParser(INT8_OID, (v) => Number(v));

const DEFAULT_POOL_MAX = 10;
const SERVERLESS_POOL_MAX = 3;
const IDLE_TIMEOUT_MS = 10_000;

/** Pool size: PG_POOL_MAX if set (must be a positive integer), else 3 on Vercel (one pool per function instance), else 10. */
export function resolvePoolMax(env: NodeJS.ProcessEnv): number {
  const raw = env.PG_POOL_MAX;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isInteger(n) || n < 1) throw new Error(`PG_POOL_MAX must be a positive integer (got "${raw}")`);
    return n;
  }
  return env.VERCEL ? SERVERLESS_POOL_MAX : DEFAULT_POOL_MAX;
}

export function createPostgresDb(databaseUrl: string, env: NodeJS.ProcessEnv = process.env): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: resolvePoolMax(env),
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    allowExitOnIdle: true,
  });
  // Idle clients can error (e.g. server restart); without a listener that would crash the process. Never log the URL.
  pool.on('error', (err) => console.error('[agentteams-hub] postgres pool error:', err.message));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
