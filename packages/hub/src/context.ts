import type { Kysely } from 'kysely';
import { monotonicFactory } from 'ulid';
import type { ToolKind } from '@agentteams/shared';
import type { GithubVerifier } from './github.js';
import type { Dialect } from './db/index.js';
import type { Database } from './db/schema.js';

export interface HubContext {
  db: Kysely<Database>;
  dialect: Dialect;
  now: () => Date;
  newId: () => string;
  mode: 'local' | 'hosted';
  /** Hosted mode only; performs network I/O, so call it outside withTx. */
  verifyGithub?: GithubVerifier;
}

/** The authenticated agent making a request. */
export interface Actor {
  id: string;
  teamId: string;
  name: string;
  member: string;
  tool: ToolKind;
}

export function createContext(
  db: Kysely<Database>,
  opts: { now?: () => Date; dialect?: Dialect; mode?: 'local' | 'hosted'; verifyGithub?: GithubVerifier } = {},
): HubContext {
  const now = opts.now ?? (() => new Date());
  const ulid = monotonicFactory();
  return {
    db, dialect: opts.dialect ?? 'sqlite', now, newId: () => ulid(now().getTime()),
    mode: opts.mode ?? 'local', verifyGithub: opts.verifyGithub,
  };
}

const MAX_TX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 10;
const RETRYABLE_PG_CODES = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

function isRetryable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE_PG_CODES.has(code);
}

/**
 * Runs fn inside a transaction. Never call withTx from inside another withTx.
 * On Postgres the transaction is SERIALIZABLE and retried (3 attempts, 10ms x attempt backoff) on
 * serialization failures / deadlocks, so fn must be safe to re-run. SQLite serialises writers itself.
 */
export async function withTx<T>(ctx: HubContext, fn: (tx: HubContext) => Promise<T>): Promise<T> {
  if (ctx.db.isTransaction) throw new Error('withTx must not be nested');
  if (ctx.dialect !== 'postgres') return ctx.db.transaction().execute((trx) => fn({ ...ctx, db: trx }));
  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.db.transaction().setIsolationLevel('serializable').execute((trx) => fn({ ...ctx, db: trx }));
    } catch (err) {
      if (attempt >= MAX_TX_ATTEMPTS || !isRetryable(err)) throw err;
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * attempt));
    }
  }
}
