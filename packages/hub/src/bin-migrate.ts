#!/usr/bin/env node
import { createDb } from './db/index.js';
import { migrateToLatest } from './db/migrations.js';

// Run as the Vercel build command (or by hand). Never logs DATABASE_URL.
// Prefer the direct (unpooled) connection: migrations need session-level behaviour a pooler may not give.
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  // Only production (or AGENTTEAMS_MIGRATE_REQUIRED=1) treats a missing database as fatal.
  console.error('agentteams-hub-migrate: DATABASE_URL is not set; skipping migrations');
  process.exit(process.env.AGENTTEAMS_MIGRATE_REQUIRED === '1' || process.env.VERCEL_ENV === 'production' ? 1 : 0);
}
const { db } = await createDb({ databaseUrl: url });
try {
  await migrateToLatest(db);
  console.log('agentteams-hub-migrate: migrations applied');
} catch (err) {
  console.error(`agentteams-hub-migrate: failed: ${(err as Error).message.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://***')}`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
