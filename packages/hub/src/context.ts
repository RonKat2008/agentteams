import type { Kysely } from 'kysely';
import { monotonicFactory } from 'ulid';
import type { ToolKind } from '@agentteams/shared';
import type { Database } from './db/schema.js';

export interface HubContext {
  db: Kysely<Database>;
  now: () => Date;
  newId: () => string;
}

/** The authenticated agent making a request. */
export interface Actor {
  id: string;
  teamId: string;
  name: string;
  member: string;
  tool: ToolKind;
}

export function createContext(db: Kysely<Database>, opts: { now?: () => Date } = {}): HubContext {
  const now = opts.now ?? (() => new Date());
  const ulid = monotonicFactory();
  return { db, now, newId: () => ulid(now().getTime()) };
}

/** Runs fn inside a transaction. Never call withTx from inside another withTx. */
export function withTx<T>(ctx: HubContext, fn: (tx: HubContext) => Promise<T>): Promise<T> {
  return ctx.db.transaction().execute((trx) => fn({ ...ctx, db: trx }));
}
